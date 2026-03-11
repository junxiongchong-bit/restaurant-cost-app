Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d C:\Users\chong\Project\restaurant-cost-app && node server.js", 0, False
