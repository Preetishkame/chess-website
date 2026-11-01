# ♟️ Zero Period Chess

**Zero Period Chess** is a web-based chess platform where users can play chess against the computer or other players online.

## 🌐 Live Website

https://zero-period-chess.onrender.com

## 📌 About the Project

Zero Period Chess is designed to provide a simple and interactive chess-playing experience through a web browser. It combines chess gameplay, computer opponents, and online multiplayer features in one platform.

## ✨ Features

- Interactive chessboard
- Play against computer
- Multiple bot difficulty levels
- Online multiplayer
- User login and registration
- Player profiles
- Game history
- Leaderboard
- Responsive interface
- Dark and light theme

*Note: Features should be verified against the currently deployed version.*

## 🛠️ Technologies Used

- **Backend:** Python, Flask
- **Frontend:** HTML, CSS, JavaScript
- **Chess Engine:** python-chess
- **Real-time Communication:** Flask-SocketIO
- **Database:** PostgreSQL / SQLite
- **Deployment:** Render

## 💻 Run Locally

### 1. Clone the repository

```bash
git clone https://github.com/Preetishkame/chess-website.git
```

### 2. Open the project folder

```bash
cd chess-website
```

### 3. Create a virtual environment

```bash
python -m venv .venv
```

### 4. Activate the environment

**Windows:**

```powershell
.\.venv\Scripts\Activate.ps1
```

### 5. Install dependencies

```bash
pip install -r requirements.txt
```

### 6. Configure environment variables

Create a `.env` file and add:

```env
SECRET_KEY=your_secret_key
DATABASE_URL=your_postgresql_connection_string
```

### 7. Run the application

```bash
python -m flask run --port=5000
```

Open your browser and visit:

```text
http://127.0.0.1:5000
```

## 🚀 Deployment

The project is deployed using Render.

**Live Website:** https://zero-period-chess.onrender.com

## 🔮 Future Improvements

- Improved computer AI
- Better multiplayer experience
- Advanced player statistics
- Improved mobile interface
- More customization options

## 👨‍💻 Developer

**Preetish Kame**

## 📂 GitHub Repository

https://github.com/Preetishkame/chess-website

---

**Zero Period Chess — Play. Think. Checkmate.**
