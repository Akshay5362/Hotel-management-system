# 🏨 Webline PMS Plus — Hotel Management System

A full-stack **Property Management System (PMS)** for hotels built with React + Vite (frontend) and Node.js + Express + MySQL (backend).

## ✨ Features

- **Room Dashboard** — Live grid view of all rooms (Vacant, Occupied, Dirty, Booked, Inactive)
- **Check-In / Check-Out** — Full guest folio management with ledger posting
- **Room Shifting** — Move guests between rooms seamlessly
- **Bill Posting** — Add restaurant, laundry, and other charges to room ledger
- **Cash Status** — Daily transaction log and cash position
- **Night Audit / Day End** — Roll business date, auto-post room tariff & taxes
- **Reports** — Occupancy reports and financial summaries
- **Real-time Clock** — Live business date and time display

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, Vanilla CSS |
| Backend | Node.js, Express.js |
| Database | MySQL 8.0 |
| ORM/Driver | mysql2/promise |
| Dev Server | nodemon |

## 🚀 Getting Started

### Prerequisites
- Node.js v18+
- MySQL 8.0+

### 1. Clone the repository
```bash
git clone https://github.com/your-username/hotel-management-system.git
cd hotel-management-system
```

### 2. Setup Backend
```bash
cd backend
npm install

# Copy env template and fill in your MySQL credentials
cp .env.example .env
# Edit .env with your DB_USER, DB_PASSWORD, etc.

# Initialize the database (creates tables and seeds demo data)
node init_db.js

# Start backend dev server
npm run dev
```
Backend runs on **http://localhost:5000**

### 3. Setup Frontend
```bash
# From project root
npm install
npm run dev
```
Frontend runs on **http://localhost:5173**

## 📁 Project Structure

```
hotel/
├── backend/
│   ├── controllers/
│   │   ├── auditController.js   # Day-end & status API
│   │   └── roomController.js    # Room operations API
│   ├── routes/
│   │   └── api.js               # Express router
│   ├── db.js                    # MySQL connection pool
│   ├── init_db.js               # DB init & seed script
│   ├── server.js                # Express app entry point
│   └── .env.example             # Environment variable template
├── src/
│   ├── components/              # React components
│   │   ├── CheckInModal.jsx
│   │   ├── CheckOutModal.jsx
│   │   ├── RoomShiftingModal.jsx
│   │   ├── CashStatusModal.jsx
│   │   ├── ReportsModal.jsx
│   │   ├── RoomGrid.jsx
│   │   ├── MetricsBar.jsx
│   │   └── Toolbar.jsx
│   ├── App.jsx                  # Main application
│   ├── main.jsx                 # React entry point
│   └── index.css                # Global styles
├── index.html
├── vite.config.js
└── package.json
```

## 🌐 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Get all rooms, cash log & system date |
| POST | `/api/dayend` | Run night audit / roll business date |
| POST | `/api/rooms/:number/checkin` | Check in a guest |
| POST | `/api/rooms/:number/checkout` | Check out a guest |
| POST | `/api/rooms/:number/clean` | Mark room as clean |
| POST | `/api/rooms/:number/ledger` | Add ledger/bill item |
| POST | `/api/rooms/shift` | Shift guest to another room |

## 📄 License

MIT
