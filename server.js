const express = require('express');
const multer = require('multer');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const app = express();

// Telegram Bot Config
const TELEGRAM_BOT_TOKEN = '7259083087:AAFubjsR9m354XfljFrpU5G64A-_7T_tMuQ'; // Replace with your bot token
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
let lastUpdateId = 0; // Track the last update ID for polling

let chatIds = []; // Dynamically store Telegram chat IDs from incoming messages

// Create HTTP server
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: 'http://localhost:3000',
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json());
app.use(express.static('uploads'));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

let messages = []; // In-memory message store

// Exponential backoff variables
let pollingInterval = 2000; // Start polling interval at 2 seconds
const minInterval = 2000;   // Minimum interval of 2 seconds
const maxInterval = 60000;  // Max interval of 60 seconds in case of errors
const backoffFactor = 2;    // Backoff multiplier

// Polling function to get updates from Telegram
const pollTelegramUpdates = async () => {
  try {
    const response = await axios.get(`${TELEGRAM_API_URL}/getUpdates`, {
      params: {
        offset: lastUpdateId + 1,
        timeout: 100,
      }
    });

    const updates = response.data.result;
    if (updates.length > 0) {
      updates.forEach((update) => {
        if (update.message) {
          const chatId = update.message.chat.id;
          const message = {
            text: update.message.text,
            sender: update.message.from.first_name || 'Unknown',
            platform: 'telegram',
            timestamp: new Date(),
          };

          // Store the chat ID dynamically
          if (!chatIds.includes(chatId)) {
            chatIds.push(chatId);
          }

          messages.push(message);
          io.emit('message', message); // Broadcast message to WebSocket clients

          // Update lastUpdateId
          lastUpdateId = update.update_id;
        }
      });

      // Reset polling interval if successful
      pollingInterval = minInterval;
    }
  } catch (error) {
    console.error('Error fetching updates from Telegram:', error);

    // If an error occurs (e.g., rate-limited), apply exponential backoff
    if (pollingInterval < maxInterval) {
      pollingInterval *= backoffFactor; // Increase the interval for next poll
    }
  } finally {
    // Schedule the next poll with the (possibly adjusted) interval
    setTimeout(pollTelegramUpdates, pollingInterval);
  }
};

// Start polling Telegram
pollTelegramUpdates();

// Socket.io connection
io.on('connection', (socket) => {
  console.log('A user connected');

  // Emit all messages to the newly connected client
  socket.emit('allMessages', messages);

  // Handle message sent from the web app
  socket.on('sendMessage', async (message) => {
    messages.push(message); // Save the message to memory

    // Send the message to all stored chat IDs (Telegram)
    try {
      for (let chatId of chatIds) {
        if (message.fileUrl) {
          await axios.post(`${TELEGRAM_API_URL}/sendPhoto`, {
            chat_id: chatId,
            photo: message.fileUrl,
            caption: message.text,
          });
        } else {
          await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
            chat_id: chatId,
            text: message.text,
          });
        }
      }
    } catch (error) {
      console.error('Error sending message to Telegram:', error);
    }

    io.emit('message', message); // Broadcast the new message to all connected clients
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

// Endpoint to get messages
app.get('/api/messages', (req, res) => {
  res.json(messages);
});

// Endpoint to send a message (with or without file)
app.post('/api/messages', upload.single('file'), (req, res) => {
  const message = {
    text: req.body.text,
    sender: req.body.sender,
    platform: req.body.platform,
    fileUrl: req.file ? `http://localhost:5000/${req.file.filename}` : null,
    timestamp: new Date(),
  };

  messages.push(message);
  io.emit('message', message); // Broadcast the new message to all connected clients
  res.json(message);
});

// Start the server
server.listen(5000, () => {
  console.log('Server is running on port 5000');
});
