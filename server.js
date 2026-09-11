const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Порт для Render или 3000 локально
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Проверяем и создаем папку uploads, если её нет
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Раздача файлов сайта (public) и загруженных картинок (uploads)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

// Если вдруг index.html лежит в корне проекта, а не в public:
app.get('/', (req, res) => {
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(publicIndex)) {
    res.sendFile(publicIndex);
  } else {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

// Настройка сохранения файлов на диск
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}${ext}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 } // до 15 МБ на файл
});

// Роут для загрузки картинок
app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Файл не прикреплен' });
  }
  res.json({ url: `/uploads/${req.file.filename}` });
});

// Память комнат: roomId -> { clients: Set, state: { strokes: [], tokens: [], showGrid: true } }
const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients: new Set(),
      state: {
        strokes: [],
        tokens: [],
        showGrid: true
      }
    });
  }
  return rooms.get(roomId);
}

// WebSocket сервер
wss.on('connection', (ws, req) => {
  // Извлекаем название комнаты из URL, например: ?room=dungeon1
  let roomId = 'default-room';
  if (req.url && req.url.includes('?')) {
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    roomId = urlParams.get('room') || 'default-room';
  }

  const room = getOrCreateRoom(roomId);
  room.clients.add(ws);

  // Сразу отправляем новому игроку текущее состояние стола
  ws.send(JSON.stringify({
    action: 'INIT_STATE',
    state: room.state
  }));

  broadcastViewerCount(room);

  // Обработка действий ведущего и игроков
  ws.on('message', (messageRaw) => {
    try {
      const data = JSON.parse(messageRaw);

      switch (data.action) {
        case 'STROKE_BATCH':
          if (Array.isArray(data.batch)) {
            room.state.strokes.push(...data.batch);
          }
          broadcastToRoom(room, ws, data);
          break;

        case 'TOKENS_UPDATE':
          room.state.tokens = data.tokens || [];
          broadcastToRoom(room, ws, data);
          break;

        case 'GRID_TOGGLE':
          room.state.showGrid = data.showGrid;
          broadcastToRoom(room, ws, data);
          break;

        case 'CLEAR_DRAWINGS':
          room.state.strokes = [];
          broadcastToRoom(room, ws, data);
          break;
      }
    } catch (err) {
      console.error('Ошибка в WS сообщении:', err);
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    broadcastViewerCount(room);
  });
});

function broadcastToRoom(room, senderWs, data) {
  const payload = JSON.stringify(data);
  room.clients.forEach((client) => {
    if (client !== senderWs && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function broadcastViewerCount(room) {
  const payload = JSON.stringify({
    action: 'VIEWER_COUNT',
    count: room.clients.size
  });
  room.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

server.listen(PORT, () => {
  console.log(`⚔️ Сервер запущен на порту ${PORT}`);
});