# Offline narration with a Windows SAPI voice. Reads build/captions.json (array of
# strings) and writes build/audio/NN.wav, one file per console step.
param([string]$Build = "build", [string]$Voice = "Microsoft Zira Desktop", [int]$Rate = 0)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech
$captions = Get-Content -Raw -Encoding UTF8 (Join-Path $Build "captions.json") | ConvertFrom-Json
$audio = Join-Path $Build "audio"
New-Item -ItemType Directory -Force $audio | Out-Null
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
for ($i = 0; $i -lt $captions.Count; $i++) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SelectVoice($Voice)
  $synth.Rate = $Rate
  $path = Join-Path $audio ("{0:D2}.wav" -f $i)
  $synth.SetOutputToWaveFile($path, $format)
  $synth.Speak([string]$captions[$i])
  $synth.Dispose()
  Write-Output $path
}
