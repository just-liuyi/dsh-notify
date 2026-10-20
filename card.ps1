param(
    [string]$Title = 'DeepSeek Harness',
    [string]$Body = '',
    [int]$Seconds = 20,
    [string]$Bg = '',
    [string]$Fg = '',
    [string]$Fg2 = '',
    [string]$Hint = '',
    [string]$Border = '',
    [string]$ProcessName = 'DeepSeek Harness'
)
# Self-drawn attention card for dsh-notify.
#
# Windows drops toasts raised by the desktop app (no registered
# AppUserModelID), and a toast attributed to PowerShell cannot bring the app
# back. This card is our own small topmost window: clicking it restores and
# focuses DeepSeek Harness, then closes the card.
#
# Colours arrive from the Client, which reads the live DSH theme tokens; when
# they are absent the palette follows the Windows app theme and DSH's own
# light/dark values. CSS colours may carry alpha, so every value is flattened
# onto the card surface: Win32 controls reject transparent colours.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshCardWin32 {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
}
"@

function Get-CardPalette {
    $light = $true
    try {
        $personalize = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction Stop
        if ($null -ne $personalize.AppsUseLightTheme) { $light = $personalize.AppsUseLightTheme -ne 0 }
    }
    catch {
        $light = $true
    }
    if ($light) {
        # DSH light: surface #ffffff, primary #0f1115, secondary #61666b.
        return @{ Bg = '#ffffff'; Fg = '#0f1115'; Fg2 = '#61666b'; Hint = '#9aa0a6' }
    }
    # DSH dark: surface #2c2c2e, primary #f9fafb, secondary #cfd3d6.
    return @{ Bg = '#2c2c2e'; Fg = '#f9fafb'; Fg2 = '#cfd3d6'; Hint = '#8d9298' }
}

# Parse #rgb / #rrggbb / #rrggbbaa and flatten the alpha onto a backdrop.
function Get-CardColor([string]$value, [System.Drawing.Color]$backdrop, [System.Drawing.Color]$fallback) {
    if ([string]::IsNullOrWhiteSpace($value)) { return $fallback }
    $text = $value.Trim().TrimStart('#')
    if ($text.Length -eq 3) {
        $text = '{0}{0}{1}{1}{2}{2}' -f $text[0], $text[1], $text[2]
    }
    if ($text.Length -ne 6 -and $text.Length -ne 8) { return $fallback }
    if ($text -notmatch '^[0-9a-fA-F]+$') { return $fallback }
    $r = [Convert]::ToInt32($text.Substring(0, 2), 16)
    $g = [Convert]::ToInt32($text.Substring(2, 2), 16)
    $b = [Convert]::ToInt32($text.Substring(4, 2), 16)
    if ($text.Length -eq 6) { return [System.Drawing.Color]::FromArgb(255, $r, $g, $b) }
    $alpha = [Convert]::ToInt32($text.Substring(6, 2), 16) / 255.0
    $red = [int][Math]::Round(($r * $alpha) + ($backdrop.R * (1 - $alpha)))
    $green = [int][Math]::Round(($g * $alpha) + ($backdrop.G * (1 - $alpha)))
    $blue = [int][Math]::Round(($b * $alpha) + ($backdrop.B * (1 - $alpha)))
    return [System.Drawing.Color]::FromArgb(255, $red, $green, $blue)
}

# A 1px separator derived from the surface when the theme supplies none.
function Get-CardBorderColor([System.Drawing.Color]$surface) {
    $luminance = (0.299 * $surface.R) + (0.587 * $surface.G) + (0.114 * $surface.B)
    if ($luminance -gt 140) { return [System.Drawing.Color]::FromArgb(255, 226, 228, 232) }
    return [System.Drawing.Color]::FromArgb(255, 58, 60, 64)
}

function New-RoundedPath([single]$width, [single]$height, [single]$radius) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $diameter = $radius * 2
    $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
    $path.AddArc(($width - $diameter), 0, $diameter, $diameter, 270, 90)
    $path.AddArc(($width - $diameter), ($height - $diameter), $diameter, $diameter, 0, 90)
    $path.AddArc(0, ($height - $diameter), $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

try {
    $palette = Get-CardPalette
    $white = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
    $cardBg = Get-CardColor $(if ($Bg) { $Bg } else { $palette.Bg }) $white ([System.Drawing.Color]::White)
    $cardFg = Get-CardColor $(if ($Fg) { $Fg } else { $palette.Fg }) $cardBg ([System.Drawing.Color]::FromArgb(15, 17, 21))
    $cardFg2 = Get-CardColor $(if ($Fg2) { $Fg2 } else { $palette.Fg2 }) $cardBg ([System.Drawing.Color]::FromArgb(97, 102, 107))
    $cardHint = Get-CardColor $(if ($Hint) { $Hint } else { $palette.Hint }) $cardBg ([System.Drawing.Color]::FromArgb(154, 160, 166))
    if ($Border) {
        $cardBorder = Get-CardColor $Border $cardBg (Get-CardBorderColor $cardBg)
    }
    else {
        $cardBorder = Get-CardBorderColor $cardBg
    }

    $width = 368
    $height = 100

    $script:CardForm = New-Object System.Windows.Forms.Form
    $script:CardForm.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $script:CardForm.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    $script:CardForm.TopMost = $true
    $script:CardForm.ShowInTaskbar = $false
    # The form paints the 1px border; the inset panel paints the card surface.
    $script:CardForm.BackColor = $cardBorder
    $script:CardForm.Size = New-Object System.Drawing.Size($width, $height)
    $script:CardForm.Cursor = [System.Windows.Forms.Cursors]::Hand

    $work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $script:CardForm.Location = New-Object System.Drawing.Point(($work.Right - $width - 20), ($work.Bottom - $height - 20))
    $script:CardForm.Region = New-Object System.Drawing.Region (New-RoundedPath $width $height 16)

    $panel = New-Object System.Windows.Forms.Panel
    $panel.BackColor = $cardBg
    $panel.SetBounds(1, 1, ($width - 2), ($height - 2))
    $panel.Cursor = [System.Windows.Forms.Cursors]::Hand

    $titleLabel = New-Object System.Windows.Forms.Label
    $titleLabel.Text = $Title
    $titleLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
    $titleLabel.ForeColor = $cardFg
    $titleLabel.BackColor = $cardBg
    $titleLabel.SetBounds(15, 12, 334, 22)

    $bodyLabel = New-Object System.Windows.Forms.Label
    $bodyLabel.Text = $Body
    $bodyLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
    $bodyLabel.ForeColor = $cardFg2
    $bodyLabel.BackColor = $cardBg
    $bodyLabel.SetBounds(15, 37, 334, 20)

    $hintLabel = New-Object System.Windows.Forms.Label
    $hintLabel.Text = "点击卡片回到 $ProcessName"
    $hintLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 8)
    $hintLabel.ForeColor = $cardHint
    $hintLabel.BackColor = $cardBg
    $hintLabel.SetBounds(15, 61, 334, 18)

    $panel.Controls.AddRange(@($titleLabel, $bodyLabel, $hintLabel))
    $script:CardForm.Controls.Add($panel)

    $script:Activate = {
        try {
            $target = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
                Where-Object { $_.MainWindowHandle -ne 0 } |
                Select-Object -First 1
            if ($null -ne $target) {
                [void][DshCardWin32]::ShowWindow($target.MainWindowHandle, 9)
                [void][DshCardWin32]::SetForegroundWindow($target.MainWindowHandle)
            }
        }
        catch {
            # activating is best-effort; the card still closes
        }
        $script:CardForm.Close()
    }

    $script:CardForm.Add_Click($script:Activate)
    $panel.Add_Click($script:Activate)
    $titleLabel.Add_Click($script:Activate)
    $bodyLabel.Add_Click($script:Activate)
    $hintLabel.Add_Click($script:Activate)

    $script:CardTimer = New-Object System.Windows.Forms.Timer
    $script:CardTimer.Interval = [Math]::Max(3, $Seconds) * 1000
    $script:CardTimer.Add_Tick({
        param($sender, $e)
        $sender.Stop()
        $script:CardForm.Close()
    })
    $script:CardTimer.Start()

    [void]$script:CardForm.ShowDialog()
}
catch {
    # A card that cannot be drawn must never show a .NET crash dialog.
    if ($env:DSH_CARD_LOG) {
        "ERROR: $($_.Exception.Message)`n$($_.ScriptStackTrace)" | Add-Content -LiteralPath $env:DSH_CARD_LOG
    }
    exit 0
}
