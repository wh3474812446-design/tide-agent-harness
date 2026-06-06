' Tide launcher - starts the supervisor completely hidden (no console window).
' Pure ASCII on purpose (Chinese Windows encoding pitfalls).
Set sh = CreateObject("WScript.Shell")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
cmd = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "supervisor.ps1"""
' 0 = hidden window, False = do not wait for it to finish.
sh.Run cmd, 0, False
