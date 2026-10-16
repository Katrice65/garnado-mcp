module.exports = {
  apps: [
    {
      name: "garnado-server",
      script: "dist/index.js",
      cwd: __dirname,              // so dotenv finds .env in the project root
      autorestart: true,           // restart if it crashes
      max_restarts: 10,
      min_uptime: "5s",            // a crash within 5s counts as a failed start
      restart_delay: 2000,
      out_file: "./logs/server-out.log",
      error_file: "./logs/server-error.log",
      time: true,                  // timestamp every log line
    },
    {
      name: "garnado-tunnel",
      script: "C:/Users/Katri/AppData/Local/Microsoft/WinGet/Packages/Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe/ngrok.exe",
      args: "http --url=ripping-salaried-lapped.ngrok-free.dev 3000",
      interpreter: "none",         // ngrok is a program, not a Node script
      autorestart: true,
      restart_delay: 3000,
      out_file: "./logs/tunnel-out.log",
      error_file: "./logs/tunnel-error.log",
      time: true,
    },
  ],
};