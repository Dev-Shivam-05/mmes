@echo off
rem MMES weekly paper run on NSE's live option chain (docs/spec/pnl-v1.md row 8). Double-click on an expiry day before
rem 09:15 and leave the window open until about 15:20. It keeps the PC awake while it runs. On a day that is not an
rem expiry it says so and stops. With --push it commits data/ and pushes the live branch at the end.
cd /d "%~dp0.."
python -I scripts\paper_nse.py --push
echo.
echo Finished (exit code %ERRORLEVEL%). The log is in .cache\nse-snapshots\.
pause
