@echo off
chcp 65001 > nul
title Quiz Sunucusu
cd /d "%~dp0"

REM Node.js kurulu mu?
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo  HATA: Node.js bulunamadi.
    echo.
    echo  Lutfen https://nodejs.org adresinden Node.js indir ve kur,
    echo  sonra bu dosyayi tekrar cift tikla.
    echo.
    pause
    exit /b 1
)

REM Bagimliliklar yuklu mu?
if not exist "node_modules\" (
    echo.
    echo  Ilk kurulum yapiliyor, lutfen bekle... (1-2 dakika)
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo  HATA: Bagimliliklar yuklenemedi.
        pause
        exit /b 1
    )
)

echo.
echo ============================================
echo   Quiz Sunucusu baslatildi
echo ============================================
echo   Bu pencereyi KAPATMA, quiz boyunca acik kalsin.
echo   Quiz bitince bu pencereye gelip kapatabilirsin.
echo ============================================
echo.

node server\server.js

pause
