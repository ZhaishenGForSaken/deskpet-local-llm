' Double-click to start DeskPet (no console window, no npm needed)
Option Explicit
Dim fso, sh, root, exe
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
exe = root & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exe) Then
  MsgBox "Electron not found:" & vbCrLf & exe & vbCrLf & vbCrLf & "Run 'npm install' in this folder once.", vbExclamation, "DeskPet"
  WScript.Quit 1
End If
sh.CurrentDirectory = root
' Window style must be 1 (normal), not 0 (hidden): Windows applies the launch style to the
' first normally-shown window of the process, which made the first settings / chat window
' invisible. electron.exe is a GUI app, so no console window appears either way.
sh.Run """" & exe & """ .", 1, False
