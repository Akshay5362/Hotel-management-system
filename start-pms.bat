@echo off
echo =======================================================================
echo               🏨 Webline PMS Plus - One-Click Launcher
echo =======================================================================
echo.

:: Check Docker Status
echo [1/3] Checking Docker daemon...
docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Docker is not running. Please start Docker Desktop first.
    pause
    exit /b 1
)

:: Check if hotel-mysql container exists
docker inspect hotel-mysql >nul 2>&1
if %errorlevel% neq 0 (
    echo [2/3] MySQL container does not exist. Creating and starting 'hotel-mysql'...
    docker run --name hotel-mysql -e MYSQL_ROOT_PASSWORD=Akshu@5362 -e MYSQL_DATABASE=hotel_pms -p 3306:3306 -d mysql:8.0
    echo Waiting for MySQL to initialize...
    timeout /t 10 /nobreak >nul
) else (
    echo [2/3] MySQL container exists. Ensuring it is running...
    docker start hotel-mysql >nul 2>&1
)

:: Wait for MySQL to accept connections
echo Waiting for MySQL to be ready...
:wait_mysql
docker exec hotel-mysql mysqladmin ping -h localhost -u root -pAkshu@5362 >nul 2>&1
if %errorlevel% neq 0 (
    timeout /t 2 /nobreak >nul
    goto wait_mysql
)
echo MySQL is ready!

:: Run database migrations
echo [3/3] Running migrations...
cd backend
call npm run migrate
cd ..

echo.
echo Starting Webline PMS Plus in Electron...
npm run electron:dev
