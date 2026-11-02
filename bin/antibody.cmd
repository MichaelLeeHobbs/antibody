@echo off
rem Windows shim for PowerShell and cmd: `antibody <command>` runs the CLI next to this file.
node "%~dp0antibody.mjs" %*
