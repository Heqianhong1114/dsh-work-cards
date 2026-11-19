Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class WC { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c); [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h); [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw); [DllImport("gdi32.dll")] public static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags); }'

try { [WC]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null } catch { }

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$root = $env:DSH_WORK_CARDS_DIR
if (-not $root) { $root = Join-Path $env:USERPROFILE '.dsh\work-cards' }
$statePath = Join-Path $root 'state.json'
$posPath = Join-Path $root 'positions.json'
$logPath = Join-Path $root 'window.log'
$dismissPath = Join-Path $root 'dismissed.json'

function Log([string]$m) {
    try { Add-Content -Path $logPath -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) -Encoding UTF8 } catch { }
}

function Write-Hb {
    try {
        $tmp = $script:hbPath + '.tmp'
        Set-Content -Path $tmp -Value ([pscustomobject]@{ pid = $PID; ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress) -Encoding UTF8
        Move-Item -Path $tmp -Destination $script:hbPath -Force -ErrorAction SilentlyContinue
    } catch { }
}

$script:hbPath = Join-Path $root 'manager.hb'
$script:lockPath = Join-Path $root 'manager.lock'
$script:lockStream = $null
try {
    $script:lockStream = [System.IO.File]::Open($script:lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $script:lockStream.SetLength(0)
} catch {
    Log 'another manager holds the lock; exit'
    exit
}
Write-Hb
Log ('manager pid=' + $PID + ' acquired lock')
function Brush([string]$hex) {
    New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($hex))
}

function Format-Ms([int]$ms) {
    if ($ms -le 0) { return '--' }
    $s = [Math]::Floor($ms / 1000)
    if ($s -ge 3600) { return ('{0}:{1:00}' -f [Math]::Floor($s / 3600), [Math]::Floor(($s % 3600) / 60)) }
    return ('{0:00}:{1:00}' -f [Math]::Floor($s / 60), ($s % 60))
}

function Load-Positions {
    $map = @{}
    try {
        if (Test-Path $posPath) {
            $raw = Get-Content $posPath -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($p in $raw.PSObject.Properties) { $map[$p.Name] = $p.Value }
        }
    } catch { }
    return $map
}

function Save-Positions($map) {
    try {
        $map | ConvertTo-Json -Depth 4 | Set-Content -Path $posPath -Encoding UTF8
    } catch { Log ('save pos failed: ' + $_.Exception.Message) }
}

function Load-Dismissed {
    $map = @{}
    try {
        if (Test-Path $dismissPath) {
            $raw = Get-Content $dismissPath -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($p in $raw.PSObject.Properties) { $map[$p.Name] = [double]$p.Value }
        }
    } catch { }
    return $map
}

function Save-Dismissed($map) {
    try {
        $map | ConvertTo-Json -Depth 4 | Set-Content -Path $dismissPath -Encoding UTF8
    } catch { }
}

function Dismiss-Card($w) {
    try {
        $id = [string]$w.Tag.id
        $script:dismissed[$id] = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        Save-Dismissed $script:dismissed
        $script:wins.Remove($id) | Out-Null
        $script:order.Remove($id) | Out-Null
        try { $w.Tag.dwin.Close() } catch { }
        $w.Close()
        $script:layoutKey = ''
        Layout-Stack
    } catch { }
}

$script:positions = Load-Positions
$script:dismissed = Load-Dismissed
$script:wins = @{}
$script:missing = @{}
$script:order = New-Object System.Collections.ArrayList
$script:selected = $null
$script:expanded = $false
$script:phase = 0
$script:details = @{}
$script:aux = New-Object System.Collections.ArrayList
$script:target = @{}
$script:lastCue = 0
$script:disp = @{}
$script:layoutKey = ""
$script:order = New-Object System.Collections.ArrayList

$app = New-Object System.Windows.Application
$app.ShutdownMode = 'OnExplicitShutdown'

$script:screenW = 1707
$script:screenH = 1067
try {
    $script:screenW = [WC]::GetSystemMetrics(0)
    $script:screenH = [WC]::GetSystemMetrics(1)
} catch { }

function Card-Window([string]$id, [int]$index) {
    $w = New-Object System.Windows.Window
    $w.WindowStyle = 'None'
    $w.Background = Brush '#FFFFFFFF'
    $w.Topmost = $true
    $w.ShowInTaskbar = $false
    $w.Width = 330
    $w.Height = 100
    $w.ResizeMode = 'NoResize'
    $w.Tag = $id

    $border = New-Object System.Windows.Controls.Border
    $border.CornerRadius = 8
    $border.Background = Brush '#FFFFFFFF'
    $border.BorderBrush = Brush '#FFE2E5EA'
    $border.BorderThickness = 1
    $border.Padding = '10,8,10,8'
    $w.Content = $border

    $grid = New-Object System.Windows.Controls.Grid
    $border.Child = $grid
    foreach ($h in 18, 22, 22) {
        $rd = New-Object System.Windows.Controls.RowDefinition
        $rd.Height = New-Object System.Windows.GridLength([double]$h, [System.Windows.GridUnitType]::Pixel)
        $grid.RowDefinitions.Add($rd) | Out-Null
    }

    $head = New-Object System.Windows.Controls.Grid
    $head.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition))
    $tc = New-Object System.Windows.Controls.ColumnDefinition
    $tc.Width = 'Auto'
    $head.ColumnDefinitions.Add($tc)
    $cc = New-Object System.Windows.Controls.ColumnDefinition
    $cc.Width = 'Auto'
    $head.ColumnDefinitions.Add($cc)
    $grid.Children.Add($head) | Out-Null

    $title = New-Object System.Windows.Controls.TextBlock
    $title.FontFamily = 'Microsoft YaHei UI'
    $title.FontSize = 11
    $title.Foreground = Brush '#FF6B7280'
    $title.TextTrimming = 'CharacterEllipsis'
    $title.VerticalAlignment = 'Center'
    $head.Children.Add($title) | Out-Null

    $toggle = New-Object System.Windows.Controls.Border
    $toggle.CornerRadius = 4
    $toggle.Background = Brush '#FFF2F4F7'
    $toggle.BorderBrush = Brush '#FFE2E5EA'
    $toggle.BorderThickness = 1
    $toggle.Padding = '7,2,7,2'
    $toggle.VerticalAlignment = 'Center'
    $toggle.Margin = '0,0,8,0'
    $toggle.Cursor = 'Hand'
    $toggle.Tag = $w
    $tglText = New-Object System.Windows.Controls.TextBlock
    $tglText.FontFamily = 'Microsoft YaHei UI'
    $tglText.FontSize = 10
    $tglText.Foreground = Brush '#FF6B7280'
    $tglText.Text = ''
    $toggle.Child = $tglText
    [System.Windows.Controls.Grid]::SetColumn($toggle, 1)
    $toggle.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true })
    $toggle.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Toggle-Expand })
    $head.Children.Add($toggle) | Out-Null

    $side = New-Object System.Windows.Window
    $side.WindowStyle = 'None'
    $side.Background = Brush '#FFF3F5F9'
    $side.Topmost = $true
    $side.ShowInTaskbar = $false
    $side.Width = 24
    $side.Height = 64
    $side.ResizeMode = 'NoResize'
    $sideBorder = New-Object System.Windows.Controls.Border
    $sideBorder.CornerRadius = 6
    $sideBorder.Background = Brush '#FFF3F5F9'
    $sideBorder.BorderBrush = Brush '#FFDDE1E8'
    $sideBorder.BorderThickness = 1
    $sideBorder.Cursor = 'Hand'
    $sideBorder.Tag = $w
    $sideText = New-Object System.Windows.Controls.TextBlock
    $sideText.Text = [char]0x25B8
    $sideText.FontFamily = 'Segoe UI'
    $sideText.FontSize = 11
    $sideText.Foreground = Brush '#FF7B8494'
    $sideText.HorizontalAlignment = 'Center'
    $sideText.VerticalAlignment = 'Center'
    $sideBorder.Child = $sideText
    $side.Content = $sideBorder
    $sideBorder.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true })
    $sideBorder.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Toggle-Detail $s.Tag })
    $side.Add_MouseLeftButtonUp({ param($s, $e) Toggle-Detail $w })
    $w.Tag = @{ id = $id }
    if (-not $script:aux) { $script:aux = New-Object System.Collections.ArrayList }
    [void]$script:aux.Add($side)
    $side.Tag = $w

    $close = New-Object System.Windows.Controls.TextBlock
    $close.Text = [char]0x00D7
    $close.FontFamily = 'Microsoft YaHei UI'
    $close.FontSize = 14
    $close.Foreground = Brush '#FFB0B7C3'
    $close.HorizontalAlignment = 'Right'
    $close.VerticalAlignment = 'Center'
    $close.Padding = '6,0,0,0'
    $close.Cursor = 'Hand'
    $close.Tag = $w
    [System.Windows.Controls.Grid]::SetColumn($close, 3)
    $close.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true })
    $close.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Dismiss-Card $s.Tag })
    $head.Children.Add($close) | Out-Null

    $row1 = New-Object System.Windows.Controls.StackPanel
    $row1.Orientation = 'Horizontal'
    [System.Windows.Controls.Grid]::SetRow($row1, 1)
    $dot = New-Object System.Windows.Shapes.Ellipse
    $dot.Width = 7; $dot.Height = 7
    $dot.Fill = Brush '#FF22C55E'
    $dot.Margin = '0,0,6,0'
    $dot.VerticalAlignment = 'Center'
    $row1.Children.Add($dot) | Out-Null
    $act = New-Object System.Windows.Controls.TextBlock
    $act.FontFamily = 'Microsoft YaHei UI'
    $act.FontSize = 13
    $act.FontWeight = 'Bold'
    $act.Foreground = Brush '#FF111827'
    $act.TextTrimming = 'CharacterEllipsis'
    $act.MaxWidth = 215
    $row1.Children.Add($act) | Out-Null
    $el = New-Object System.Windows.Controls.TextBlock
    $el.FontFamily = 'Consolas'
    $el.FontSize = 11
    $el.Foreground = Brush '#FF9CA3AF'
    $el.Margin = '6,0,0,0'
    $el.VerticalAlignment = 'Center'
    $row1.Children.Add($el) | Out-Null
    $grid.Children.Add($row1) | Out-Null

    $row2 = New-Object System.Windows.Controls.Grid
    [System.Windows.Controls.Grid]::SetRow($row2, 2)
    $row2.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition))
    $c2 = New-Object System.Windows.Controls.ColumnDefinition
    $c2.Width = 'Auto'
    $row2.ColumnDefinitions.Add($c2)

    $track = New-Object System.Windows.Controls.Border
    $track.Height = 6
    $track.CornerRadius = 3
    $track.Background = Brush '#FFF1F3F5'
    $track.VerticalAlignment = 'Center'
    $track.Margin = '0,0,8,0'
    $track.ClipToBounds = $true
    $row2.Children.Add($track) | Out-Null
    $bar = New-Object System.Windows.Controls.Grid
    $col0 = New-Object System.Windows.Controls.ColumnDefinition
    $col1 = New-Object System.Windows.Controls.ColumnDefinition
    $bar.ColumnDefinitions.Add($col0) | Out-Null
    $bar.ColumnDefinitions.Add($col1) | Out-Null
    $fill = New-Object System.Windows.Controls.Border
    $fill.Height = 6
    $fill.Background = Brush '#FF3B82F6'
    $fill.HorizontalAlignment = 'Stretch'
    [System.Windows.Controls.Grid]::SetColumn($fill, 0)
    $bar.Children.Add($fill) | Out-Null
    $track.Child = $bar

    $foot = New-Object System.Windows.Controls.TextBlock
    $foot.FontFamily = 'Microsoft YaHei UI'
    $foot.FontSize = 10
    $foot.Foreground = Brush '#FF6B7280'
    $foot.VerticalAlignment = 'Center'
    [System.Windows.Controls.Grid]::SetColumn($foot, 1)
    $row2.Children.Add($foot) | Out-Null
    $grid.Children.Add($row2) | Out-Null

    $dwin = New-Object System.Windows.Window
    $dwin.Tag = $w
    [void]$script:aux.Add($dwin)
    $dwin.WindowStyle = 'None'
    $dwin.Background = Brush '#FFFFFFFF'
    $dwin.Topmost = $true
    $dwin.ShowInTaskbar = $false
    $dwin.Width = 280
    $dwin.SizeToContent = 'Height'
    $dwin.ResizeMode = 'NoResize'
    $dborder = New-Object System.Windows.Controls.Border
    $dborder.CornerRadius = 8
    $dborder.Background = Brush '#FFFFFFFF'
    $dborder.BorderBrush = Brush '#FFDDE1E8'
    $dborder.BorderThickness = 1
    $dborder.Padding = '10,8,10,8'
    $dwin.Content = $dborder
    $detail = New-Object System.Windows.Controls.StackPanel
    $dborder.Child = $detail
    $detail.Visibility = 'Visible'

    $w.Tag = @{ id = $id; title = $title; dot = $dot; act = $act; el = $el; fill = $fill; foot = $foot; toggle = $toggle; toggleText = $tglText; col0 = $col0; colF = $colF; col1 = $col1; border = $border; detail = $detail; side = $side; sideText = $sideText; dwin = $dwin; track = $track; sig = ''; noDetail = $false }

    $w.Add_Closed({ try { $w.Tag.side.Close() } catch { }; try { $w.Tag.dwin.Close() } catch { } })
    $w.Add_MouseLeftButtonDown({
        param($sender, $e)
        try {
            if ($e.ClickCount -eq 2) {
                $p = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
                if ($p) { [WC]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [WC]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }
                return
            }
            $pt = $e.GetPosition($sender)
            $sender.Tag.dragX = $sender.Left
            $sender.Tag.dragY = $sender.Top
            $sender.Tag.dragPX = $pt.X
            $sender.Tag.dragPY = $pt.Y
            $sender.Tag.moved = 0
            $sender.CaptureMouse() | Out-Null
        } catch { }
    })
    $w.Add_MouseMove({
        param($sender, $e)
        try {
            if ($e.LeftButton -ne [System.Windows.Input.MouseButtonState]::Pressed) { return }
            if ($null -eq $sender.Tag.dragPX) { return }
            $pt = $e.GetPosition($sender)
            $dx = $pt.X - $sender.Tag.dragPX
            $dy = $pt.Y - $sender.Tag.dragPY
            if ($sender.Tag.moved -eq 0 -and ([Math]::Abs($dx) + [Math]::Abs($dy) -lt 4)) { return }
            $sender.Tag.moved = 1
            $sender.Tag.dragging = $true
            $sender.Left = [double]$sender.Tag.dragX + $dx
            $sender.Top = [double]$sender.Tag.dragY + $dy
        } catch { }
    })
    $w.Add_MouseLeftButtonUp({
        param($sender, $e)
        try {
            $sender.ReleaseMouseCapture()
            $id2 = [string]$sender.Tag.id
            if ($sender.Tag.moved -eq 1) {
                $script:positions[$id2] = @([int]$sender.Left, [int]$sender.Top)
                Save-Positions $script:positions
            }
            $script:selected = $id2
            $sender.Tag.dragPX = $null
            $sender.Tag.moved = 0
            $sender.Tag.dragging = $false
            Layout-Stack
        } catch { }
    })

    return $w
}

function Round-Card($w) {
    try {
        $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($w)).Handle
        $s = [double]([WC]::GetDpiForWindow($hwnd)) / 96.0
        if ($s -le 0) { $s = 1.0 }
        $r = [int](16 * $s)
        $ww = [double]$w.Width
        $hh = [double]$w.Height
        if ([double]::IsNaN($ww)) { $ww = [double]$w.ActualWidth }
        if ([double]::IsNaN($hh)) { $hh = [double]$w.ActualHeight }
        if ($ww -le 0 -or $hh -le 0) { return }
        $px = [int]($ww * $s)
        $py = [int]($hh * $s)
        $rgn = [WC]::CreateRoundRectRgn(0, 0, $px + 1, $py + 1, $r, $r)
        [WC]::SetWindowRgn($hwnd, $rgn, $true) | Out-Null
    } catch { Log ('round: ' + $_.Exception.Message) }
}

function Place-Card($w, [int]$index) {
    $id = $w.Tag.id
    $h = $w.Height
    $s = 1.0
    try {
        $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($w)).Handle
        $s = [double]([WC]::GetDpiForWindow($hwnd)) / 96.0
    } catch { }
    if ($s -le 0) { $s = 1.0 }
    $sh = $script:screenH / $s
    if ($script:positions.ContainsKey($id)) {
        $p = $script:positions[$id]
        $w.Left = [double]$p[0]
        $w.Top = [double]$p[1]
    }
}

$script:player = $null
function Init-Cue {
    try {
        $cuePath = $env:DSH_WORK_CARDS_CUE
        if (-not $cuePath) { $cuePath = Join-Path $env:DSH_WORK_CARDS_DIR 'cue.mp3' }
        if (Test-Path $cuePath) {
            $script:player = New-Object System.Windows.Media.MediaPlayer
            $script:player.Open([Uri]$cuePath)
            $script:player.Volume = 1.0
            Log ('cue loaded: ' + $cuePath)
        }
    } catch { Log ('cue load err: ' + $_.Exception.Message) }
}

function Play-Cue([string]$kind) {
    try {
        if ($script:player) {
            $script:player.Position = [TimeSpan]::Zero
            $script:player.Play()
        } elseif ($kind -eq 'wait') {
            [System.Media.SystemSounds]::Exclamation.Play()
        } else {
            [System.Media.SystemSounds]::Asterisk.Play()
        }
    } catch { }
    Log ("cue " + $kind)
}

function Toggle-Detail($w) {
    try {
        $id = [string]$w.Tag.id
        $open = ($script:details.ContainsKey($id) -and $script:details[$id])
        if ($open) {
            $script:details[$id] = $false
            try { $w.Tag.dwin.Hide() } catch { }
            $w.Tag.sideText.Text = [char]0x25B8
            return
        }
        $script:details[$id] = $true
        $w.Tag.sideText.Text = [char]0x25BE
        $st2 = Get-CardState $id
        Render-Detail $w $st2
        Show-Detail $w
        Log ("detail open id=" + $id + " lines=" + (@($w.Tag.detail.Children).Count))
    } catch { Log ('detail err: ' + $_.Exception.Message) }
}

function Place-Detail($w) {
    try {
        $d = $w.Tag.dwin
        $s = 1.0
        $dipH = [double][System.Windows.SystemParameters]::PrimaryScreenHeight
        if ($dipH -gt 0) { $s = $script:screenH / $dipH }
        if ($s -le 0) { $s = 1.0 }
        $sh = $script:screenH / $s
        $dipW = [double][System.Windows.SystemParameters]::PrimaryScreenWidth
        $sw = if ($dipW -gt 0) { $dipW } else { 1920 }
        $left = $w.Tag.side.Left + $w.Tag.side.Width + 6
        if (($left + [double]$d.Width) -gt ($sw - 8)) {
            $left = [double]$w.Left - [double]$d.Width - 6
            if ($left -lt 8) { $left = 8 }
        }
        $top = [double]$w.Top + [double]$w.Height - [double]$d.Height
        if (($top + [double]$d.Height) -gt ($sh - 56)) { $top = $sh - 56 - [double]$d.Height }
        if ($top -lt 8) { $top = 8 }
        $d.Left = [Math]::Round($left)
        $d.Top = [Math]::Round($top)
    } catch { }
}

function Show-Detail($w) {
    try {
        $d = $w.Tag.dwin
        if ($d.IsVisible) { return }
        Place-Detail $w
        $d.Show()
        Round-Card $d
        Place-Detail $w
    } catch { }
}

function Position-Detail($w) {
    try {
        $d = $w.Tag.dwin
        if (-not $d.IsVisible) { return }
        Place-Detail $w
    } catch { }
}
function Get-CardState([string]$id) {
    try {
        $st = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($c in @($st.cards)) { if ([string]$c.id -eq $id) { return $c } }
    } catch { }
    return $null
}

function Render-Detail($w, $card) {
    if ($null -eq $card) { return }
    if (-not ($script:details.ContainsKey([string]$w.Tag.id) -and $script:details[[string]$w.Tag.id])) { return }
    $rec = @($card.recent)
    $sig = ($rec | ForEach-Object { "$($_.t)$($_.text)" }) -join '|'
    if ($sig -eq [string]$w.Tag.sig) { return }
    $w.Tag.sig = $sig
    $w.Tag.detail.Children.Clear()
    $shown = @($rec | Select-Object -Last 6)
    if ($shown.Count -eq 0) {
        $emptyLine = New-Object System.Windows.Controls.TextBlock
        $emptyLine.FontFamily = 'Microsoft YaHei UI'
        $emptyLine.FontSize = 10
        $emptyLine.Foreground = Brush '#FF9CA3AF'
        $emptyLine.Text = '还没有可显示的动作'
        $w.Tag.detail.Children.Add($emptyLine) | Out-Null
    }
    foreach ($r in $shown) {
        $line = New-Object System.Windows.Controls.TextBlock
        $line.FontFamily = 'Microsoft YaHei UI'
        $line.FontSize = 10
        $line.Foreground = Brush '#FF5B6472'
        $line.Margin = '0,2,0,0'
        $line.TextTrimming = 'CharacterEllipsis'
        $line.Text = "$($r.t)  $($r.text)"
        $w.Tag.detail.Children.Add($line) | Out-Null
    }
    $rows = [Math]::Max(1, $shown.Count)
    Round-Card $w.Tag.dwin
    Place-Detail $w
}
function Update-Card($w, $card) {
    $t = $w.Tag
    $t.title.Text = [string]$card.title
    $t.act.Text = [string]$card.activity
    $t.el.Text = Format-Ms ([int]$card.elapsed)
    switch ([string]$card.status) {
        'running' { $t.dot.Fill = Brush '#FF22C55E' }
        'thinking' { $t.dot.Fill = Brush '#FF3B82F6' }
        'waiting' { $t.dot.Fill = Brush '#FFF59E0B' }
        default { $t.dot.Fill = Brush '#FF9CA3AF' }
    }
    $cur = [string]$card.status
    $isDone = ($cur -eq 'idle')
    if ($isDone) {
        $w.Background = Brush '#FFF1F6FF'
        $t.border.Background = Brush '#FFF1F6FF'
        $t.border.BorderBrush = Brush '#FFBFDBFE'
    } else {
        $w.Background = Brush '#FFFFFFFF'
        $t.border.Background = Brush '#FFFFFFFF'
        $t.border.BorderBrush = Brush '#FFE2E5EA'
    }
    $prevStatus = [string]$t.prevStatus
    if ($cur -eq 'idle' -and [bool]$t.wasActive -and $card.ended -eq $true) {
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        if (($nowMs - [double]$script:lastCue) -gt 5000) { Play-Cue 'done'; $script:lastCue = $nowMs }
    }
    if ($cur -eq 'running' -or $cur -eq 'thinking' -or $cur -eq 'waiting') { $t.wasActive = $true }
    if ($cur -eq 'idle') { $t.wasActive = $false }
    $t.prevStatus = $cur
    # 进度条 = 状态指示：进行中循环滑块 / 等你确认半条 / 已完成满条
    $idKey = [string]$w.Tag.id
    $st = [string]$card.status
    $det = -1.0
    if ($card.ended -eq $true) { $det = 1.0 }
    elseif ($st -eq 'waiting') { $det = 0.5 }
    $w.Tag.indet = ($det -lt 0)
    if ($det -ge 0) {
        $script:target[$idKey] = $det
        if (-not $script:disp.ContainsKey($idKey)) { $script:disp[$idKey] = $det }
    }
    if ([int]$card.total -gt 0) {
        $t.track.Visibility = 'Visible'
        $etaTxt = if ($card.eta) { ' · 约 ' + (Format-Ms ([int]$card.eta)) } else { '' }
        $t.foot.Text = "$($card.done)/$($card.total) 项$etaTxt"
    } elseif ($card.status -eq 'waiting') {
        $t.track.Visibility = 'Visible'
        $t.foot.Text = '等你确认'
    } elseif ($card.status -eq 'idle') {
        $t.track.Visibility = 'Visible'
        $t.foot.Text = '已完成'
    } else {
        $t.track.Visibility = 'Visible'
        $stuck = [int]$card.stuckMs
        if ($stuck -ge 30000) {
            $t.foot.Text = ((Format-Ms $stuck) + ' 无动作')
        } else {
            $t.foot.Text = '进行中'
        }
    }
    $w.Tag.noDetail = (@($card.recent).Count -eq 0)
    Render-Detail $w $card
}

function Raise-Card($w) {
    try {
        $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($w)).Handle
        [WC]::SetWindowPos($hwnd, [IntPtr]::new(-1), 0, 0, 0, 0, 0x0013) | Out-Null
    } catch { }
}

function Toggle-Expand {
    $script:expanded = -not $script:expanded
    Layout-Stack
}

function Update-Toggles($ids) {
    $n = $ids.Count
    foreach ($k in $script:wins.Keys) {
        $w = $script:wins[$k]
        if ($null -eq $w) { continue }
        try {
            if ($null -eq $w.Tag.toggle) { continue }
            if ($n -le 1 -or $w.Tag.id -ne $script:firstId) { $w.Tag.toggle.Visibility = 'Collapsed'; continue }
            $w.Tag.toggle.Visibility = 'Visible'
            if ($script:expanded) { $w.Tag.toggleText.Text = '合上' } else { $w.Tag.toggleText.Text = "展开 $n" }
        } catch { }
    }
}

function Place-Side($w) {
    try {
        $side = $w.Tag.side
        if (-not $side) { return }
        if ([bool]$w.Tag.noDetail) { if ($side.IsVisible) { $side.Hide() }; return }
        $side.Left = $w.Left + $w.Width + 6
        $side.Top = $w.Top + [Math]::Max(0, [double](($w.Height - $side.Height) / 2))
        if (-not $side.IsVisible) { $side.Show(); Round-Card $side }
        Raise-Card $side
    } catch { }
}

function Resolve-Overlaps {
    try {
        $placed = @()
        # 先占住已打开的详情浮层，卡片绕开它
        foreach ($k in @($script:wins.Keys)) {
            $cw = $script:wins[$k]
            if ($null -eq $cw) { continue }
            $dw = $cw.Tag.dwin
            if ($dw -and $dw.IsVisible) {
                $placed += [pscustomobject]@{ x = [double]$dw.Left; y = [double]$dw.Top; w = [double]$dw.Width; h = [double]$dw.Height }
            }
        }
        foreach ($k in $script:order) {
            if (-not $script:wins.ContainsKey($k)) { continue }
            $w = $script:wins[$k]
            if ([bool]$w.Tag.dragging) {
                $placed += [pscustomobject]@{ x = [double]$w.Left; y = [double]$w.Top; w = [double]$w.Width; h = [double]$w.Height }
                continue
            }
            if (-not $w.IsVisible) { continue }
            $x = [double]$w.Left
            $y = [double]$w.Top
            $ww = [double]$w.Width
            $hh = [double]$w.Height
            $guard = 0
            while ($guard -lt 30) {
                $hit = $null
                foreach ($p in $placed) {
                    if (($x -lt ($p.x + $p.w)) -and (($x + $ww) -gt $p.x) -and ($y -lt ($p.y + $p.h)) -and (($y + $hh) -gt $p.y)) { $hit = $p; break }
                }
                if ($null -eq $hit) { break }
                $y = $hit.y + $hit.h + 8
                $guard++
            }
            $w.Top = [Math]::Round($y)
            $placed += [pscustomobject]@{ x = $x; y = $y; w = $ww; h = $hh }
        }
    } catch { Log ('overlap: ' + $_.Exception.Message) }
}

function Layout-Stack {
    $ids = @()
    foreach ($k in $script:order) {
        if ($script:wins.ContainsKey($k) -and -not $script:positions.ContainsKey($k)) { $ids += $k }
    }
    if ($ids.Count -eq 0) { $script:firstId = $null; Update-Toggles $ids; return }
    $script:firstId = $ids[0]
    Update-Toggles $ids
    $s = 1.0
    try {
        $dipH = [double][System.Windows.SystemParameters]::PrimaryScreenHeight
        if ($dipH -gt 0) { $s = $script:screenH / $dipH }
    } catch { }
    if ($s -le 0) { $s = 1.0 }
    $sh = $script:screenH / $s
    $gap = 8.0
    if ($script:expanded) {
        $total = 0.0
        foreach ($k in $ids) { $total += [double]$script:wins[$k].Height }
        $total += $gap * ($ids.Count - 1)
        $y = [Math]::Round($sh - 56 - $total)
        if ($y -lt 20) { $y = 20 }
        foreach ($k in $ids) {
            $w = $script:wins[$k]
            if ([bool]$w.Tag.dragging) {
                $placed += [pscustomobject]@{ x = [double]$w.Left; y = [double]$w.Top; w = [double]$w.Width; h = [double]$w.Height }
                continue
            }
            $w.Left = 16
            $w.Top = [Math]::Round($y)
            $y += [double]$w.Height + $gap
            if (-not $w.IsVisible) { $w.Show(); Round-Card $w }
            Raise-Card $w
            Place-Side $w
            Position-Detail $w
        }
    } else {
        $w = $script:wins[$ids[0]]
        $w.Left = 16
        $w.Top = [Math]::Round($sh - 56 - [double]$w.Height)
        if (-not $w.IsVisible) { $w.Show(); Round-Card $w }
        Raise-Card $w
        Place-Side $w
        Position-Detail $w
        foreach ($k in $ids) {
            if ($k -eq $ids[0]) { continue }
            $o = $script:wins[$k]
            if ($o.IsVisible) { $o.Hide() }
            try { if ($o.Tag.side.IsVisible) { $o.Tag.side.Hide() } } catch { }
            try { if ($o.Tag.dwin.IsVisible) { $o.Tag.dwin.Hide() } } catch { }
        }
    }
    Resolve-Overlaps
    foreach ($k in $ids) {
        $w2 = $script:wins[$k]
        if ($w2.IsVisible) { Place-Side $w2; Position-Detail $w2 }
    }
}
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({
    try {
        try {
            $hbr2 = Get-Content $script:hbPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $hbAge2 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double]$hbr2.ts
            if ([int]$hbr2.pid -ne $PID -and [int]$hbr2.pid -lt $PID -and $hbAge2 -lt 5000) { Log ('duplicate manager, yield to pid ' + $hbr2.pid); [System.Environment]::Exit(0) }
        } catch { }
        try { Write-Hb } catch { }
        if (-not (Test-Path $statePath)) { return }
        $st = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $cards = @($st.cards)
        $script:phase = ($script:phase + 6) % 60
        $seen = @{}
        $i = 0
        $new = @()
        foreach ($c in $cards) {
            $id = [string]$c.id
            $ts = 0.0
            if ($null -ne $c.turnStart) { $ts = [double]$c.turnStart }
            if ($script:dismissed.ContainsKey($id)) {
                $dAt = [double]$script:dismissed[$id]
                if ($ts -le $dAt) { continue }
                $script:dismissed.Remove($id) | Out-Null
                Save-Dismissed $script:dismissed
            }
            $st = [string]$c.status
            if ($st -eq 'idle' -and -not $script:wins.ContainsKey($id)) { continue }
            $seen[$id] = $true
            if (-not $script:wins.ContainsKey($id)) {
                $w = Card-Window $id $i
                $script:wins[$id] = $w
                [void]$script:order.Add($id)
                Place-Card $w $i
                $new += $id
            }
            Update-Card $script:wins[$id] $c
            $i++
        }
        foreach ($k in @($script:wins.Keys)) {
            if ($seen.ContainsKey($k)) {
                $script:missing.Remove($k) | Out-Null
                continue
            }
            $n = 0
            if ($script:missing.ContainsKey($k)) { $n = [int]$script:missing[$k] }
            $n++
            $script:missing[$k] = $n
            if ($n -ge 40) {
                try { $script:wins[$k].Close() } catch { }
                $script:wins.Remove($k) | Out-Null
                $script:missing.Remove($k) | Out-Null
                $script:order.Remove($k) | Out-Null
            }
        }
        $key = (@($script:order) -join ',') + '|' + [string]$script:selected
        if ($key -ne $script:layoutKey) {
            $script:layoutKey = $key
            Layout-Stack
        }
        foreach ($nid in $new) {
            $nw = $script:wins[$nid]
            if ($null -eq $nw) { continue }
            $showIt = $script:expanded -or ($nid -eq $script:firstId)
            if ($showIt -and -not $nw.IsVisible) {
                $nw.Show()
                Round-Card $nw
            }
        }
        foreach ($auxw in @($script:aux)) {
            try {
                $hostCard = $auxw.Tag
                if ($null -eq $hostCard) { continue }
                if (-not $hostCard.IsVisible) { if ($auxw.IsVisible) { $auxw.Hide() } }
            } catch { }
        }
        Resolve-Overlaps
        foreach ($k in @($script:wins.Keys)) {
            $cw = $script:wins[$k]
            if ($cw.IsVisible) { Place-Side $cw; Position-Detail $cw }
        Position-Tools
        }
    } catch { Log ('tick: ' + $_.Exception.Message) }
})

Init-Cue
$timer.Start()

$anim = New-Object System.Windows.Threading.DispatcherTimer
$anim.Interval = [TimeSpan]::FromMilliseconds(33)
$anim.Add_Tick({
    try {
        foreach ($k in @($script:wins.Keys)) {
            $w = $script:wins[$k]
            if ($null -eq $w -or -not $w.IsVisible) { continue }
            if ([bool]$w.Tag.dragging) { continue }
            $tag = $w.Tag
            if ([bool]$tag.indet) {
                $raw = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() % 1600) / 1600.0
                $phase = 1.0 - [Math]::Abs(1.0 - 2.0 * $raw)
                $seg = 0.3
                $left = $phase * (1.0 - $seg)
                $right = 1.0 - $left - $seg
                $tag.col0.Width = New-Object System.Windows.GridLength -ArgumentList @([double]$left, ([System.Windows.GridUnitType]::Star))
                $tag.colF.Width = New-Object System.Windows.GridLength -ArgumentList @([double]$seg, ([System.Windows.GridUnitType]::Star))
                $tag.col1.Width = New-Object System.Windows.GridLength -ArgumentList @([double]$right, ([System.Windows.GridUnitType]::Star))
                continue
            }
            if (-not $script:target.ContainsKey($k)) { continue }
            $cur = [double]$script:disp[$k]
            $tgt = [double]$script:target[$k]
            $cur = $cur + ($tgt - $cur) * 0.28
            if ([Math]::Abs($tgt - $cur) -lt 0.002) { $cur = $tgt }
            $script:disp[$k] = $cur
            $r1 = [double]$cur
            $r2 = [double](1.0 - $r1)
            $tag.col0.Width = New-Object System.Windows.GridLength -ArgumentList @(0.0, ([System.Windows.GridUnitType]::Star))
            $tag.colF.Width = New-Object System.Windows.GridLength -ArgumentList @($r1, ([System.Windows.GridUnitType]::Star))
            $tag.col1.Width = New-Object System.Windows.GridLength -ArgumentList @($r2, ([System.Windows.GridUnitType]::Star))
        }
    } catch { }
})
$anim.Start()
$script:tools = $null
function New-Tools {
    $win = New-Object System.Windows.Window
    $win.WindowStyle = 'None'
    $win.Background = Brush '#FFFFFFFF'
    $win.Topmost = $true
    $win.ShowInTaskbar = $false
    $win.Width = 96
    $win.Height = 28
    $win.ResizeMode = 'NoResize'
    $bd = New-Object System.Windows.Controls.Border
    $bd.CornerRadius = 6
    $bd.Background = Brush '#FFFFFFFF'
    $bd.BorderBrush = Brush '#FFE2E5EA'
    $bd.BorderThickness = 1
    $win.Content = $bd
    $sp = New-Object System.Windows.Controls.StackPanel
    $sp.Orientation = 'Horizontal'
    $sp.HorizontalAlignment = 'Center'
    $sp.VerticalAlignment = 'Center'
    $bd.Child = $sp
    $btnRefresh = New-Object System.Windows.Controls.TextBlock
    $btnRefresh.Text = [char]0x21BB
    $btnRefresh.FontFamily = 'Segoe UI'
    $btnRefresh.FontSize = 13
    $btnRefresh.Foreground = Brush '#FF6B7280'
    $btnRefresh.Margin = '8,0,8,0'
    $btnRefresh.Cursor = 'Hand'
    $btnRefresh.Add_MouseLeftButtonUp({ param($s, $e); try { Set-Content -Path (Join-Path $env:DSH_WORK_CARDS_DIR 'refresh.req') -Value ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -Encoding UTF8 } catch { } })
    $sp.Children.Add($btnRefresh) | Out-Null
    $btnRestore = New-Object System.Windows.Controls.TextBlock
    $btnRestore.Text = [char]0x27F2
    $btnRestore.FontFamily = 'Segoe UI'
    $btnRestore.FontSize = 13
    $btnRestore.Foreground = Brush '#FF6B7280'
    $btnRestore.Margin = '8,0,8,0'
    $btnRestore.Cursor = 'Hand'
    $btnRestore.Add_MouseLeftButtonUp({ param($s, $e); try { $script:dismissed = @{}; Save-Dismissed $script:dismissed; $script:layoutKey = ''; Layout-Stack } catch { } })
    $sp.Children.Add($btnRestore) | Out-Null
    return $win
}

function Position-Tools {
    try {
        if ($null -eq $script:tools) { return }
        $first = $null
        foreach ($k in $script:order) {
            if ($script:wins.ContainsKey($k) -and $script:wins[$k].IsVisible) { $first = $script:wins[$k]; break }
        }
        $script:tools.Left = 16
        if ($first) { $script:tools.Top = [Math]::Max(8, [double]$first.Top - 34) } else { $script:tools.Top = 40 }
    } catch { }
}
$script:tools = @(New-Tools)[-1]
if ($null -ne $script:tools) { $script:tools.Show(); Position-Tools }
Log 'manager started'
$app.Run() | Out-Null