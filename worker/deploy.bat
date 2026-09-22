@echo off
cd /d "%~dp0"
echo gieoksoop-share Worker 배포를 시작합니다...
echo.
call npx wrangler deploy --config wrangler.toml
echo.
echo (위에 "gieoksoop-share" 라는 이름으로 배포됐다고 나오고 에러가 없으면 성공이에요)
pause
