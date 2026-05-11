require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const OpenAI = require('openai');
const db = require('./localDb');
const { logToFile } = require('./logger');

// Supabase — loaded lazily so the server still starts without it
let supabase = null;
try {
  ({ supabase } = require('./supabaseClient'));
  console.log('✅ Supabase client loaded');
} catch (e) {
  console.warn('⚠️  Supabase unavailable — will serve local DB only:', e.message);
}

db.initDb();


const app = express();
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.url} - ${res.statusCode} (${duration}ms)`);
  });
  next();
});

app.get('/api/health', (req, res) => {
  try {
    const dbData = db.readDb();
    res.json({ status: 'ok', keys: Object.keys(dbData) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'PATCH'] }
});

// Add global emission logging
const originalEmit = io.emit.bind(io);
io.emit = (event, ...args) => {
  console.log(`[Socket] GLOBAL EMIT: ${event}`, JSON.stringify(args).slice(0, 100));
  return originalEmit(event, ...args);
};

// Decorate Room-specific emits
const originalTo = io.to.bind(io);
io.to = (room) => {
  const roomEmitter = originalTo(room);
  const originalRoomEmit = roomEmitter.emit.bind(roomEmitter);
  roomEmitter.emit = (event, ...args) => {
    console.log(`[Socket] ROOM ${room} EMIT: ${event}`, JSON.stringify(args).slice(0, 100));
    return originalRoomEmit(event, ...args);
  };
  return roomEmitter;
};

const PORT = process.env.PORT || 5000;

// Groq (Llama) Setup — OpenAI-compatible, free tier
const xaiClient = process.env.GROQ_API_KEY
  ? new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' })
  : null;
const XAI_MODEL = 'llama-3.3-70b-versatile';
if (xaiClient) console.log(`✅ Groq/Llama client ready: ${XAI_MODEL}`);
else            console.warn('⚠️  GROQ_API_KEY not set — AI features disabled.');

async function xaiGenerate(prompt) {
  if (!xaiClient) throw new Error('GROQ_API_KEY is not configured.');
  const res = await xaiClient.chat.completions.create({
    model: XAI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
  });
  return res.choices[0].message.content.trim();
}

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────
const onlineUsers = new Map(); // userId → socketId

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('register', (userId) => {
    if (!userId) return;
    console.log(`[Socket] Registering userId: ${userId} to socketId: ${socket.id}`);
    onlineUsers.set(userId, socket.id);
    socket.join(userId);
    
    // Log rooms for verification
    const rooms = Array.from(socket.rooms);
    console.log(`[Socket] Socket ${socket.id} is now in rooms:`, rooms);
    io.emit('presence_update', Array.from(onlineUsers.keys()));
  });

  socket.on('join_room', (roomId) => {
    socket.join(roomId);
    console.log(`Socket ${socket.id} joined room ${roomId}`);
  });

  socket.on('send_message', ({ roomId, senderId, senderName, content }) => {
    if (!roomId || !content?.trim()) return;
    const msg = db.addMessage(roomId, { senderId, senderName, content: content.trim() });
    if (msg) io.to(roomId).emit('message:new', msg);
  });

  socket.on('make_connection', ({ roomId, userId }) => {
    const room = db.setRoomConnected(roomId, userId);
    if (room) {
      io.to(roomId).emit('connection:made', { 
        roomId, 
        connected: room.connected, 
        clicks: room.connection_clicks,
        status: room.status
      });
      
      if (room.status === 'exchanged') {
        io.emit('task:removed', { taskId: room.task_id });
      }
    }
  });

  socket.on('save_notes', ({ roomId, notes }) => {
    socket.to(roomId).emit('notes:update', { roomId, notes });
  });

  socket.on('note_update', ({ roomId, content }) => {
    socket.to(roomId).emit('notes:update', { roomId, notes: content });
  });

  // ── Broadcast Group Chat ────────────────────────────────────────────────────
  socket.on('broadcast_chat:join', (broadcastId) => {
    socket.join(`broadcast-chat-${broadcastId}`);
    console.log(`Socket ${socket.id} joined broadcast chat ${broadcastId}`);
  });

  socket.on('broadcast_chat:message', ({ broadcastId, senderId, senderName, content }) => {
    if (!broadcastId || !content?.trim()) return;
    const msg = db.addBroadcastChatMessage(broadcastId, { senderId, senderName, content: content.trim() });
    if (msg) io.to(`broadcast-chat-${broadcastId}`).emit('broadcast_chat:message', msg);
  });

  socket.on('disconnect', () => {
    for (const [userId, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) { onlineUsers.delete(userId); break; }
    }
    io.emit('presence_update', Array.from(onlineUsers.keys()));
  });
});

// ─── AI RECOMMENDATIONS ──────────────────────────────────────────────────────
app.get('/api/recommendations/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const dbData = db.readDb();
    const userTasks = dbData.tasks.filter(t => t.posted_by === userId);
    const otherTasks = dbData.tasks.filter(t => t.posted_by !== userId && t.status === 'open');

    if (userTasks.length === 0) return res.json([]);

    const normalize = s => (s || '').toLowerCase().trim();

    const potentialMatches = otherTasks.filter(other => {
      const otherOffering = (Array.isArray(other.offering) ? other.offering : [other.offering || '']).map(normalize);
      const otherWanting  = (Array.isArray(other.wanting)  ? other.wanting  : [other.wanting  || '']).map(normalize);

      return userTasks.some(mine => {
        const myOffering = (Array.isArray(mine.offering) ? mine.offering : [mine.offering || '']).map(normalize);
        const myWanting  = (Array.isArray(mine.wanting)  ? mine.wanting  : [mine.wanting  || '']).map(normalize);

        // Condition 1: other person's wanting matches my offering (they need what I provide)
        const theyNeedWhatIOffer = otherWanting.some(w => myOffering.some(o => o === w));

        // Condition 2: my wanting matches other person's offering (I need what they provide)
        const iNeedWhatTheyOffer = myWanting.some(w => otherOffering.some(o => o === w));

        return theyNeedWhatIOffer && iNeedWhatTheyOffer;
      });
    });

    if (potentialMatches.length === 0) return res.json([]);

    if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "") {
      const prompt = `
        User A is offering: ${JSON.stringify(userTasks.map(t => ({ title: t.title, offering: t.offering, wanting: t.wanting })))}
        Potential matches: ${JSON.stringify(potentialMatches.map(t => ({ id: t.id, title: t.title, offering: t.offering, wanting: t.wanting })))}

        Identify the best mutual skill exchange matches.
        Return a JSON array of objects with "id" (task id) and "reason" (short 1-sentence explanation of why it's a perfect match).
        Only return the JSON.
      `;
      try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const jsonMatch = text.match(/\[.*\]/s);
        if (jsonMatch) {
          const aiMatches = JSON.parse(jsonMatch[0]);
          const finalMatches = aiMatches.map(am => {
            const task = potentialMatches.find(pm => pm.id === am.id);
            return task ? { ...task, ai_reason: am.reason } : null;
          }).filter(Boolean);
          return res.json(finalMatches);
        }
      } catch (e) {
        console.error("Gemini Error:", e);
      }
    }

    res.json(potentialMatches.slice(0, 3));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TASK ROUTES ──────────────────────────────────────────────────────────────
app.post('/api/tasks', async (req, res) => {
  const { title, description, offering, wanting, type, duration, schedule, posted_by, userName, userAvatar } = req.body;
  try {
    let ai_metadata = null;
    if (process.env.GEMINI_API_KEY) {
      try {
        const prompt = `
          Analyze this skill exchange task on Share Sphere.
          Title: ${title}
          User Offers: ${JSON.stringify(offering)}
          User Wants: ${JSON.stringify(wanting)}

          Generate a 1-sentence "match_analysis" (why this is a good exchange)
          and a short "target_peer_profile" (who would be the perfect match).
          Return ONLY valid JSON: {"analysis": "...", "target_peer": "..."}
        `;
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const jsonMatch = text.match(/\{.*\}/s);
        if (jsonMatch) ai_metadata = JSON.parse(jsonMatch[0]);
      } catch (aiErr) {
        console.error("AI Task Analysis Failed:", aiErr);
      }
    }

    const task = db.createTask({ title, description, offering, wanting, type, duration, schedule, posted_by, userName, userAvatar, ai_metadata });
    io.emit('task:new', task);
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks', (req, res) => {
  try {
    const tasks = db.getAllTasks({ excludeUserId: req.query.exclude_user_id });
    res.json(tasks);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Combined match request route moved below

app.post('/api/tasks/:taskId/request', async (req, res) => {
  const { taskId } = req.params;
  const { requested_by, message, requesterName, requesterAvatar, target_user_id, task_title, task_offering, task_wanting, owner_name, owner_avatar } = req.body;
  
  try {
    const finalTaskId = taskId === 'null' || !taskId ? null : taskId;
    const request = db.createRequest({ 
      task_id: finalTaskId, 
      requested_by, 
      message, 
      requesterName, 
      requesterAvatar,
      target_user_id,
      task_title,
      task_offering,
      task_wanting,
      owner_name,
      owner_avatar
    });

    if (request) {
      const ownerId = target_user_id || request.task.posted_by;
      const title = task_title || request.task.title;
      
      // AI Enhanced Notification
      let aiContent = `${requesterName} wants to connect for "${title}"!`;
      try {
        const prompt = `Create a super short, high-energy notification for a user named ${owner_name || 'Mentor'} because ${requesterName} just requested their task "${title}". Max 8 words.`;
        aiContent = await xaiGenerate(prompt);
      } catch (err) { console.error("xAI Notification Error:", err.message); }

      const clientsInRoom = io.sockets.adapter.rooms.get(ownerId);
      console.log(`[Request] Emitting request:new to ${ownerId}. Clients in room: ${clientsInRoom ? clientsInRoom.size : 0}`);
      
      io.to(ownerId).emit('request:new', { ...request, aiContent });
      db.addNotification({
        user_id: ownerId,
        content: aiContent,
        type: 'request_new',
        reference_id: request.id,
        task_id: finalTaskId
      });
      res.json({ request });
    } else {
      res.status(400).json({ error: 'Failed to create request' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/tasks/:taskId/requests/:requestId', (req, res) => {
  const { status } = req.body;
  const { requestId, taskId } = req.params;
  try {
    const { request, room } = db.updateRequestStatus(requestId, status);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    const requesterId = request.requested_by;
    const taskTitle = request.task?.title || 'task';

    if (status === 'accepted') {
      db.clearNotificationByReference(requestId);
      io.to(requesterId).emit('request:accepted', { roomId: room.id, taskTitle });
      if (request.task?.posted_by) {
        io.to(request.task.posted_by).emit('chat:room_created', { roomId: room.id });
      }
      if (request.task_id) {
        io.emit('task:removed', { taskId: request.task_id });
      }
      db.addNotification({
        user_id: requesterId,
        content: `Your request for "${taskTitle}" was accepted! Chat created.`,
        type: 'request_accepted',
        reference_id: room.id,
        task_id: taskId
      });
    } else {
      io.to(requesterId).emit('request:declined', { taskTitle });
    }
    res.json({ success: true, room });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chat/rooms', (req, res) => {
  try { res.json(db.getUserRooms(req.query.user_id)); } catch (err) { res.status(500).json({ error: err.message }); }
});

// Resolve a user's display name from local DB stores
// Searches: room participant_info → request requester/owner → broadcast requester
app.get('/api/user-name/:userId', (req, res) => {
  try {
    const { userId } = req.params
    const dbData = db.readDb()
    let name = ''

    // 1. Check rooms participant_info (most reliable — set at accept time)
    for (const room of dbData.rooms || []) {
      const info = room.participant_info?.[userId]
      if (info?.name && info.name !== 'User' && info.name !== 'Peer' && info.name !== 'Mentor' && info.name !== 'Partner') {
        name = info.name
        break
      }
    }

    // 2. Check request requester info
    if (!name) {
      for (const req of dbData.requests || []) {
        if (req.requested_by === userId && req.requester?.name && req.requester.name !== 'User') {
          name = req.requester.name; break
        }
        if (req.target_user_id === userId && req.owner?.name && req.owner.name !== 'User') {
          name = req.owner.name; break
        }
      }
    }

    // 3. Check broadcast request requester info
    if (!name) {
      for (const br of dbData.broadcast_requests || []) {
        if (br.requested_by === userId && br.requester?.name && br.requester.name !== 'User') {
          name = br.requester.name; break
        }
      }
    }

    // 4. Check users table
    if (!name) {
      const u = (dbData.users || []).find(u => u.id === userId)
      if (u?.name && u.name !== 'User') name = u.name
    }

    res.json({ name: name || null })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/accept-and-notify', async (req, res) => {
  try {
    const { roomId, taskId, ownerId, ownerName, requesterId, requesterName, taskTitle } = req.body
    if (!roomId || !ownerId || !requesterId) {
      return res.status(400).json({ error: 'roomId, ownerId, and requesterId are required' })
    }

    // 1. Sync the Supabase room into the local Express DB so Chat page can find it
    const room = db.syncSupabaseRoom({
      id: roomId,
      task_id: taskId || null,
      user_a: ownerId,
      user_b: requesterId,
      partner_name: requesterName || 'Peer',
      partner_avatar: null
    })

    // Update participant_info with known names and persist
    if (room) {
      if (!room.participant_info) room.participant_info = {}
      room.participant_info[ownerId]      = { name: ownerName || 'Mentor', avatar_url: null }
      room.participant_info[requesterId]  = { name: requesterName || 'Peer', avatar_url: null }
      room.task_title = taskTitle || 'Skill Exchange'
      room.status     = 'active'
      const dbData = db.readDb()
      const idx = dbData.rooms.findIndex(r => r.id === roomId)
      if (idx !== -1) dbData.rooms[idx] = room
      else dbData.rooms.push(room)
      db.writeDb(dbData)
    }

    // 2. Emit socket events to both users IMMEDIATELY (don't wait for AI)
    io.to(requesterId).emit('request:accepted', { roomId, taskTitle: taskTitle || 'Skill Exchange' })
    io.to(ownerId).emit('chat:room_created', { roomId })

    // 3. Generate AI greeting with Gemini, then broadcast it
    //    Done async so we respond to the frontend immediately
    res.json({ success: true, room })

    // --- background async: generate greeting and send to room ---
    ;(async () => {
      let greetingText = `🎉 Your skill exchange for "${taskTitle || 'Skill Exchange'}" has officially started! ${ownerName} and ${requesterName} — welcome to your shared workspace. Start by introducing yourselves and planning your first session!`

      try {
        if (xaiClient) {
          const prompt = `You are ShareSphere's AI assistant. Two users just matched for a skill exchange.
- Mentor/Acceptor: ${ownerName}
- Learner/Requester: ${requesterName}
- Exchange topic: "${taskTitle || 'Skill Exchange'}"

Write a warm, enthusiastic, and concise welcome message (2-3 sentences max) addressed to BOTH users by their first names. Celebrate the match, mention the skill topic, and encourage them to kick off the exchange. Use one relevant emoji. Do NOT include any markdown or bullet points — plain text only.`

          const aiText = await xaiGenerate(prompt)
          if (aiText && aiText.length > 10) {
            greetingText = aiText
          }
        }
      } catch (aiErr) {
        console.warn('[accept-and-notify] xAI greeting failed, using fallback:', aiErr.message)
      }

      // Save the AI greeting message with a special sender ID
      const greetMsg = db.addMessage(roomId, {
        senderId:   'ai-assistant',
        senderName: '✨ ShareSphere AI',
        content:    greetingText
      })

      if (greetMsg) {
        // Broadcast to the room — both users will see it instantly if connected
        io.to(roomId).emit('message:new', greetMsg)
        // Also notify each user individually (in case they haven't joined the room yet)
        io.to(ownerId).emit('message:new', greetMsg)
        io.to(requesterId).emit('message:new', greetMsg)
      }
    })()

    // 4. Add a local notification for the requester
    db.addNotification({
      user_id:      requesterId,
      content:      `${ownerName || 'Mentor'} accepted your exchange request! Your chat is ready.`,
      type:         'request_accepted',
      reference_id: roomId,
      task_id:      taskId || null
    })

  } catch (err) {
    console.error('[accept-and-notify] Error:', err.message)
    if (!res.headersSent) res.status(500).json({ error: err.message })
  }
})

app.post('/api/chat/sync', (req, res) => {
  try {
    const body = req.body || {};
    const { id, task_id, user_a, user_b, partner_name, partner_avatar } = body;
    if (!id || !user_a || !user_b) {
      return res.status(400).json({ error: 'id, user_a, and user_b are required' });
    }
    const room = db.syncSupabaseRoom({ id, task_id, user_a, user_b, partner_name, partner_avatar });
    res.json(room);
  } catch (err) {
    console.error('[/api/chat/sync] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chat/rooms/:id/messages', (req, res) => {
  try {
    const dbData = db.readDb();
    const room = dbData.rooms.find(r => r.id === req.params.id);
    res.json(room ? room.messages : []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/chat/rooms/:id/connect', (req, res) => {
  try {
    const { userId } = req.body;
    const room = db.setRoomConnected(req.params.id, userId);
    res.json(room);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/notes/upload', (req, res) => {
  try {
    const { userId, title, description, fileName, roomId, senderName } = req.body;
    const note = db.addNote(userId, { title, description, fileName, roomId });
    
    if (roomId) {
      const msgContent = `FILE_SHARE:${title}|${fileName}|${note.id}`;
      const msg = db.addMessage(roomId, { 
        senderId: userId, 
        senderName: senderName || "Member", 
        content: msgContent 
      });
      io.to(roomId).emit('message:new', msg);
    }
    
    res.json(note);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/chat/rooms/:id/done', (req, res) => {
  try {
    const { userId } = req.body;
    const room = db.setRoomWorkDone(req.params.id, userId);
    res.json(room);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/chat/rooms/:id/notes', (req, res) => {
  try {
    const { notes } = req.body;
    const dbData = db.readDb();
    const room = dbData.rooms.find(r => r.id === req.params.id);
    if (room) {
      room.workspace_notes = notes;
      db.writeDb(dbData);
      res.json(room);
    } else {
      res.status(404).json({ error: "Room not found" });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/notifications', (req, res) => {
  try { res.json(db.getNotifications(req.query.user_id)); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/notifications/:id/read', (req, res) => {
  try { db.markNotificationRead(req.params.id); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/notifications/:id', (req, res) => {
  try { db.deleteNotification(req.params.id); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Broadcast Class Routes ───────────────────────────────────────────────────

app.post('/api/broadcasts', (req, res) => {
  try {
    const { title, description, duration, deadline, max_people, reward_credits, category, scheduled_at, difficulty, prerequisites, status, posted_by, userName, userAvatar } = req.body;
    const broadcast = db.createBroadcast({ title, description, duration, deadline, max_people, reward_credits, category, scheduled_at, difficulty, prerequisites, status, posted_by, userName, userAvatar });
    io.emit('broadcast:new', broadcast);
    res.json(broadcast);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/broadcasts', (req, res) => {
  try {
    db.autoUpdateBroadcastStatuses();
    const includeAll = req.query.includeAll === 'true';
    res.json(db.getAllBroadcasts({ query: req.query.q, userId: req.query.user_id, includeAll }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tutor's own broadcasts (all statuses)
app.get('/api/user/:userId/broadcasts', (req, res) => {
  try { res.json(db.getTutorBroadcasts(req.params.userId)); } catch (err) { res.status(500).json({ error: err.message }); }
});

// Publish draft → published
app.patch('/api/broadcasts/:id/publish', (req, res) => {
  try {
    const broadcast = db.publishBroadcast(req.params.id);
    if (!broadcast) return res.status(404).json({ error: 'Broadcast not found' });
    io.emit('broadcast:updated', broadcast);
    res.json(broadcast);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Learner enrolls (direct, no reward negotiation)
app.post('/api/broadcasts/:id/enroll', (req, res) => {
  try {
    const { user_id, userName, userAvatar } = req.body;
    const enrollmentResult = db.enrollInBroadcast({ broadcast_id: req.params.id, user_id, userName, userAvatar });
    
    if (enrollmentResult.error) {
      return res.status(400).json({ error: enrollmentResult.error });
    }
    
    const broadcast = db.getBroadcastById(req.params.id);
    if (enrollmentResult) {
      io.to(broadcast.posted_by).emit('broadcast:enrollment', { broadcast_id: req.params.id, enrollment: enrollmentResult });
      db.addNotification({ 
        user_id: broadcast.posted_by, 
        content: `${userName} enrolled in your class: ${broadcast.title}`, 
        type: 'broadcast_enrollment', 
        reference_id: enrollmentResult.id, 
        task_id: broadcast.id 
      });
    }
    res.json(enrollmentResult);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get enrollments for a class
app.get('/api/broadcasts/:id/enrollments', (req, res) => {
  try { res.json(db.getEnrollments(req.params.id)); } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tutor starts session → live
app.patch('/api/broadcasts/:id/start', (req, res) => {
  try {
    const broadcast = db.startBroadcast(req.params.id);
    if (!broadcast) return res.status(404).json({ error: 'Broadcast not found' });
    io.emit('broadcast:live', broadcast);
    const enrollments = db.getEnrollments(req.params.id);
    enrollments.forEach(e => {
      db.addNotification({ user_id: e.user_id, content: `"${broadcast.title}" is now live! Join the session now.`, type: 'broadcast_live', task_id: broadcast.id });
      io.to(e.user_id).emit('broadcast:live', broadcast);
    });
    res.json(broadcast);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tutor ends session + settles credits
app.post('/api/broadcasts/:id/end', (req, res) => {
  try {
    const { attendances } = req.body;
    const broadcast = db.endBroadcast(req.params.id, attendances || []);
    if (!broadcast) return res.status(404).json({ error: 'Broadcast not found' });
    io.emit('broadcast:completed', broadcast);
    const attendedCount = (attendances || []).filter(a => a.attended).length;
    const totalEarned = attendedCount * (broadcast.reward_credits || 0);
    db.addNotification({ user_id: broadcast.posted_by, content: `Session ended: "${broadcast.title}". ${attendedCount} attended. You earned ${totalEarned} credits.`, type: 'broadcast_ended', task_id: broadcast.id });
    (attendances || []).forEach(a => {
      if (a.attended && broadcast.reward_credits > 0) {
        db.addNotification({ user_id: a.user_id, content: `Session complete: "${broadcast.title}". ${broadcast.reward_credits} credits deducted.`, type: 'broadcast_ended', task_id: broadcast.id });
        io.to(a.user_id).emit('broadcast:completed', broadcast);
      }
    });
    res.json(broadcast);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tutor cancels class
app.patch('/api/broadcasts/:id/cancel', (req, res) => {
  try {
    const broadcast = db.cancelBroadcast(req.params.id);
    if (!broadcast) return res.status(404).json({ error: 'Broadcast not found or cannot be cancelled' });
    io.emit('broadcast:updated', broadcast);
    const enrollments = db.getEnrollments(req.params.id);
    enrollments.forEach(e => {
      db.addNotification({ user_id: e.user_id, content: `"${broadcast.title}" has been cancelled by the tutor.`, type: 'broadcast_cancelled', task_id: broadcast.id });
      io.to(e.user_id).emit('broadcast:updated', broadcast);
    });
    res.json(broadcast);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get all classes a learner is enrolled in
app.get('/api/user/:userId/enrollments', (req, res) => {
  try { res.json(db.getUserEnrollments(req.params.userId)); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Broadcast Group Chat ─────────────────────────────────────────────────────

app.get('/api/broadcasts/:id/chat', (req, res) => {
  try {
    const room = db.getBroadcastChatRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'Broadcast not found' });
    res.json(room);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/broadcasts/:id/chat/notes', (req, res) => {
  try {
    const { notes } = req.body;
    const room = db.saveBroadcastChatNotes(req.params.id, notes);
    if (!room) return res.status(404).json({ error: 'Chat room not found' });
    io.to(`broadcast-chat-${req.params.id}`).emit('broadcast_chat:notes_update', { broadcastId: req.params.id, notes });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/broadcasts/:id/participants', (req, res) => {
  try { res.json(db.getBroadcastParticipants(req.params.id)); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/user/:userId/posts', (req, res) => {
  try { res.json(db.getUserPosts(req.params.userId)); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ai/recommend', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!xaiClient) return res.status(503).json({ error: "AI not available" });
    const text = await xaiGenerate(prompt);
    res.send(text);
  } catch (err) {
    console.error("xAI Recommend Error:", err.message);
    res.status(500).json({ error: "AI recommendation failed. Please try again later." });
  }
});

// POST /api/ai/analyze-notes
// Mode A (Polish): notes exist — enrich with chat history context + polish language.
// Mode B (Generate): no notes — build structured notes purely from chat.
// Body: { notes: string, chatHistory: string, exchangeTopic?: string }
// Response: { improved: string, action: "polished" | "generated", summary: string }
app.post('/api/ai/analyze-notes', async (req, res) => {
  try {
    if (!xaiClient) {
      return res.status(503).json({ error: 'AI is not configured on this server.' });
    }

    const { notes, chatHistory, exchangeTopic } = req.body;
    const hasNotes = notes && notes.trim().length > 10;
    const hasChat  = chatHistory && chatHistory.trim().length > 0;

    if (!hasNotes && !hasChat) {
      return res.status(400).json({ error: 'Provide either exchange notes or chat history.' });
    }

    let prompt, action;

    if (hasNotes) {
      // ── Mode A: Polish notes, enriched with real chat content ────────────
      action = 'polished';
      prompt = `You are an expert technical writer working on a skill-exchange platform called ShareSphere.

Two users ${exchangeTopic ? `are doing a skill exchange about "${exchangeTopic}"` : 'are doing a skill exchange'}.

${hasChat ? `THEIR CONVERSATION:\n---\n${chatHistory.trim()}\n---\n\n` : ''}EXISTING EXCHANGE NOTES (written by the users):\n---\n${notes.trim()}\n---

Your task — produce a single, polished, comprehensive set of Exchange Notes:
1. Start from the existing notes as the base structure
2. Extract and ADD any important information from the chat that is MISSING from the notes:
   - Agreements, decisions, plans discussed in chat
   - Skills, topics, tools, or resources mentioned
   - Scheduled times, deadlines, or next steps from the conversation
   - Any key facts or insights shared
3. Fix ALL grammar, spelling, and punctuation errors in the original notes
4. Improve sentence structure, flow, and professional clarity
5. Remove filler words, redundant phrases, and repetition
6. Preserve the original structure (headings, bullet points) and ALL existing key information
7. Keep technical terms and proper nouns exactly as written

Return ONLY the final polished notes. No preamble, no explanation, no closing statement.
Use markdown formatting (## headings, bullet lists, numbered lists) for clarity.`;

    } else {
      // ── Mode B: Generate structured notes from chat messages ─────────────
      action = 'generated';
      prompt = `You are an expert technical writer on a skill-exchange platform called ShareSphere.

Two users have been chatting${exchangeTopic ? ` about "${exchangeTopic}"` : ''} on the platform. Based on their conversation, create clear, structured collaborative exchange notes in professional English.

Structure the notes as:
## Exchange Overview
(Who is exchanging what with whom — 1-2 sentences)

## Goals & Objectives
(Bullet list of what each person wants to achieve)

## Key Points Discussed
(Important information, agreements, decisions, or insights from the conversation)

## Action Items
(Numbered list of concrete next steps agreed upon)

## Timeline / Schedule
(Any dates, deadlines, or session schedules mentioned — skip this section if none)

CHAT HISTORY:
---
${chatHistory.trim()}
---

Return ONLY the structured notes in professional English. No preamble, no explanation.`;
    }

    const improved = await xaiGenerate(prompt);

    // One-line summary
    let summary = action === 'polished'
      ? 'Notes enriched and polished from your conversation.'
      : 'Notes generated from your conversation.';
    try {
      const summaryPrompt = action === 'polished'
        ? `In one short sentence (max 14 words), describe what was added or improved in these notes: "${improved.slice(0, 200)}"`
        : `In one short sentence (max 12 words), summarise these exchange notes: "${improved.slice(0, 200)}"`;
      summary = (await xaiGenerate(summaryPrompt)).replace(/^\"|\"$/g, '');
    } catch { /* keep default summary */ }

    res.json({ improved, action, summary });

  } catch (err) {
    console.error('[ai/analyze-notes] Error:', err.message?.slice(0, 200));
    const isQuota = err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED');
    if (isQuota) {
      return res.status(429).json({ error: 'Rate limit hit. Please wait 30–60 seconds and try again.' });
    }
    res.status(500).json({ error: 'AI analysis failed. Please try again.' });
  }
});


async function analyzeUserProfile(userId) {
  try {
    const dbData = db.readDb();
    const reviews = dbData.reviews.filter(r => r.target_user_id === userId || r.reviewed_id === userId);
    if (reviews.length === 0) return;

    const reviewsText = reviews.map(r => `- [${r.rating} stars] ${r.skill_level}: ${r.comment}`).join("\n");
    
    const prompt = `
      Analyze the following peer reviews for a user on a skill-exchange platform.
      
      REVIEWS:
      ${reviewsText}
      
      Generate a JSON response with the following fields:
      1. "summary": A professional 2-sentence bio enhancement highlighting core strengths.
      2. "overall_feedback": A short paragraph summarizing what peers appreciate most.
      3. "suggested_rating": A numeric rating (1.0 - 5.0) based on peer satisfaction.
      4. "reliability_status": A short label for their exchange reliability (e.g., "Highly Reliable", "Top Contributor").
      5. "growth_areas": One key area for improvement.
      
      Output ONLY valid JSON.
    `;

    const responseText = await xaiGenerate(prompt);
    const cleanJson = responseText.replace(/```json|```/g, "").trim();
    const analysis = JSON.parse(cleanJson);
    
    const updatedDb = db.readDb();
    let userProfile = updatedDb.users.find(u => u.id === userId);
    if (!userProfile) {
      userProfile = { id: userId, reviews_count: reviews.length, rating: 0, analysis: {}, enhancements: [] };
      updatedDb.users.push(userProfile);
    }
    userProfile.analysis = analysis;
    db.writeDb(updatedDb);
    console.log(`AI Profile analysis (JSON) completed for user ${userId}`);
  } catch (err) {
    console.error("AI Analysis failed:", err);
  }
}

app.get('/api/user/:userId/profile', (req, res) => {
  try {
    const dbData = db.readDb();
    const profile = dbData.users.find(u => u.id === req.params.userId);
    res.json(profile || { id: req.params.userId, analysis: "No analysis available yet." });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/connections/:roomId/status', (req, res) => {
  try {
    const status = db.getRoomStatus(req.params.roomId);
    if (!status) return res.status(404).json({ error: "Room not found" });
    res.json(status);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/connections/:roomId/confirm', (req, res) => {
  try {
    const { roomId } = req.params;
    const { user_id, stage, delivery_note } = req.body;
    
    const { advanced, already_confirmed, confirmation } = db.confirmStage(roomId, user_id, stage, delivery_note);
    
    if (already_confirmed) return res.status(400).json({ error: "Already confirmed" });

    // Emit to peer that user confirmed
    io.to(roomId).emit('stage:confirmed', { 
      stage, 
      confirmed_by: user_id, 
      note: delivery_note 
    });

    if (delivery_note) {
      db.addMessage(roomId, { 
        senderId: user_id, 
        senderName: "Mentor", 
        content: `DELIVERY_NOTE:${delivery_note}` 
      });
      io.to(roomId).emit('delivery:note', { 
        note_text: delivery_note, 
        from_user: user_id 
      });
    }

    if (advanced) {
      const nextStage = stage === 'connected' ? 'work_done' : 'review';
      io.to(roomId).emit('stage:advanced', { 
        new_stage: nextStage, 
        room_id: roomId 
      });
    }

    res.json({ advanced, confirmation });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reviews', async (req, res) => {
  try {
    const { review, complete } = db.saveReview(req.body);
    const { room_id, reviewer_id, target_user_id } = req.body;

    if (complete) {
      // Emit to the room socket AND to both users individually
      const payload = { room_id, review_summary: review };
      io.to(room_id).emit('exchange:complete', payload);
      io.to(reviewer_id).emit('exchange:complete', payload);
      io.to(target_user_id).emit('exchange:complete', payload);
      // Sidebar badge refresh for both users
      io.to(reviewer_id).emit('room_status_update', { room_id, status: 'completed' });
      io.to(target_user_id).emit('room_status_update', { room_id, status: 'completed' });
    } else {
      io.to(room_id).emit('review:submitted', { reviewer_id, room_id });
      io.to(target_user_id).emit('review:submitted', { reviewer_id, room_id });
    }

    // Trigger AI Profile Analysis in background
    analyzeUserProfile(target_user_id || req.body.reviewed_id);

    res.json(review);
  } catch (err) {
    console.error('Review endpoint error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/disputes', (req, res) => {
  try {
    const { room_id, raised_by, reason, description } = req.body;
    const dispute = db.saveDispute({ room_id, raised_by, reason, description });
    io.to(room_id).emit('dispute:raised', { room_id, reason, raised_by });
    res.json(dispute);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/user/:userId/reviews', (req, res) => {
  try {
    const dbData = db.readDb();
    const reviews = dbData.reviews.filter(r => r.target_user_id === req.params.userId || r.reviewed_id === req.params.userId);
    res.json(reviews);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/user/:userId/requests', (req, res) => {
  try { res.json(db.getUserRequests(req.params.userId)); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/user/:userId/profile', (req, res) => {
  try {
    const user = db.updateUserProfile(req.params.userId, req.body);
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Bidirectional Matches ───────────────────────────────────────────────────
app.get('/api/matches/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = db.findBidirectionalMatches(userId);
    
    // Enrich matches with match-specific request status and room IDs
    const matches = result.matches.map(m => {
      // Use the specialized match request lookup
      const request = db.getMatchRequestBetween(userId, m.peer.id);

      if (request) {
        m.requestStatus = request.status;
        m.requestId = request.id;
        
        if (request.status === 'accepted') {
          const dbData = db.readDb();
          const room = (dbData.rooms || []).find(r => r.request_id === request.id);
          if (room) m.roomId = room.id;
        }
      }
      return m;
    });

    res.json({ ...result, matches });
  } catch (err) {
    console.error("Matches Endpoint Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/matches/:userId/enrich', async (req, res) => {
  try {
    const { matches, currentUser } = req.body;
    if (!matches?.length || !xaiClient) {
      return res.json({ matches: [] });
    }

    const prompt = `
      You are a professional skill-exchange matchmaker on Share Sphere.
      Current User: Offers ${JSON.stringify(currentUser.offering_skills)}, Wants ${JSON.stringify(currentUser.wanting_skills)}
      
      Matches to analyze:
      ${matches.map((m, i) => `${i}. Peer ${m.peer.name}: Offers ${JSON.stringify(m.peer.offering_skills)}, Wants ${JSON.stringify(m.peer.wanting_skills)}`).join('\n')}
      
      For each match, provide:
      1. "whyItWorks": A professional 1-sentence insight on why this swap is valuable.
      2. "suggestedMessage": A short, friendly opening message to start the exchange.
      3. "exchangeStrength": One of "strong", "moderate", "partial".
      
      Return ONLY valid JSON: {"matches": [{"index": 0, "whyItWorks": "...", "suggestedMessage": "...", "exchangeStrength": "..."}]}
    `;

    const text = await xaiGenerate(prompt);
    const jsonMatch = text.match(/\{.*\}/s);
    if (jsonMatch) {
      res.json(JSON.parse(jsonMatch[0]));
    } else {
      res.json({ matches: [] });
    }
  } catch (err) {
    console.error("Enrichment Error:", err.message);
    res.json({ matches: [] });
  }
});

app.post('/api/match-requests', async (req, res) => {
  try {
    const { from_user_id, to_user_id, giving_skills, receiving_skills, message, from_name, from_avatar, to_name, to_avatar } = req.body;
    
    const request = db.createMatchRequest({
      from_user_id, to_user_id,
      giving_skills, receiving_skills,
      message: message || "I'd like to connect for a skill exchange!",
      from_name, from_avatar,
      to_name, to_avatar
    });

    // AI Enhanced Notification
    let aiMatchContent = `${from_name} wants to swap skills with you!`;
    try {
      const prompt = `Create a very short, friendly notification for ${to_name || 'a peer'} because ${from_name} wants to swap skills: Giving ${JSON.stringify(giving_skills)}, Receiving ${JSON.stringify(receiving_skills)}. Max 10 words.`;
      aiMatchContent = await xaiGenerate(prompt);
    } catch (err) { console.error("xAI Match Notification Error:", err.message); }

    // Notify the target user
    const clientsInRoom = io.sockets.adapter.rooms.get(to_user_id);
    console.log(`[Match] Emitting notification:new to ${to_user_id}. Clients in room: ${clientsInRoom ? clientsInRoom.size : 0}`);
    
    io.to(to_user_id).emit('notification:new', {
      id: Date.now().toString(),
      content: aiMatchContent,
      type: 'match_request',
      reference_id: request.id,
      match_request: true
    });

    res.json(request);
  } catch (err) {
    console.error("Match Request Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/match-requests/:id', (req, res) => {
  try {
    const { status } = req.body;
    const { request, room } = db.updateMatchRequestStatus(req.params.id, status);
    if (!request) return res.status(404).json({ error: 'Request not found' });

    if (status === 'accepted' && room) {
      io.to(request.from_user_id).emit('match:accepted', { peer_name: request.to_name, chat_room_id: room.id });
      io.to(request.to_user_id).emit('match:connected', { room_id: room.id });
      
      // Also notify everyone that these users are now matched (to remove from discover lists if peer-based)
      io.emit('task:removed', { peerId: request.from_user_id, partnerId: request.to_user_id });

      db.addNotification({
        user_id: request.from_user_id,
        content: `${request.to_name} accepted your match request!`,
        type: 'match_accepted',
        reference_id: room.id,
        task_id: null
      });
    }
    res.json({ success: true, request, room });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/match-requests/user/:userId', (req, res) => {
  try { res.json(db.getMatchRequestsForUser(req.params.userId)); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Skills Endpoints ────────────────────────────────────────────────────────
app.get('/api/user/:userId/skills', (req, res) => {
  try { res.json(db.getUserSkills(req.params.userId)); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/user/:userId/skills', (req, res) => {
  try { res.json(db.addUserSkill(req.params.userId, req.body)); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/skills/:skillId', (req, res) => {
  try { db.removeUserSkill(req.params.skillId); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─── Admin Endpoints ──────────────────────────────────────────────────────────
const bcrypt = require('bcryptjs');

// POST /api/admin/login — email + password login for admin panel
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const admin = db.getAdminByEmail(email);
    if (!admin) return res.status(401).json({ error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, admin.password);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    // Update last_login
    const dbData = db.readDb();
    const a = dbData.admins.find(x => x.email?.toLowerCase() === email.toLowerCase());
    if (a) { a.last_login = new Date().toISOString(); db.writeDb(dbData); }

    // Return safe admin data (no password)
    const { password: _pw, ...safeAdmin } = admin;
    res.json({ success: true, admin: { ...safeAdmin, last_login: new Date().toISOString() } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/verify — check if email is an admin (no password needed, for route guard)
app.get('/api/admin/verify', (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email required' });
    const admin = db.getAdminByEmail(email);
    if (admin) {
      const { password: _pw, ...safe } = admin;
      res.json({ isAdmin: true, admin: safe });
    } else {
      res.json({ isAdmin: false });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/list — list all admins (no passwords)
app.get('/api/admin/list', (req, res) => {
  try {
    const admins = db.getAllAdmins().map(({ password: _pw, ...a }) => a);
    res.json(admins);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/add — add new admin
app.post('/api/admin/add', async (req, res) => {
  try {
    const { email, name, role, password, phone, department } = req.body;
    if (!email || !name || !password) return res.status(400).json({ error: 'email, name and password required' });
    const hashed = await bcrypt.hash(password, 10);
    const admin = db.addAdmin({ email, name, role, password: hashed, phone, department });
    const { password: _pw, ...safe } = admin;
    res.json({ success: true, admin: safe });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// DELETE /api/admin/remove — remove admin
app.delete('/api/admin/remove', (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    const removed = db.removeAdmin(email);
    res.json({ success: removed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Admin Data Endpoints ──────────────────────────────────────────────────────

// GET /api/admin/data/stats — summary counts for dashboard cards
app.get('/api/admin/data/stats', (req, res) => {
  try {
    const data = db.readDb();
    res.json({
      totalTasks:      (data.tasks || []).length,
      activeTasks:     (data.tasks || []).filter(t => t.status === 'open' || t.status === 'active').length,
      totalBroadcasts: (data.broadcasts || []).length,
      totalRooms:      (data.chat_rooms || []).length,
      activeRooms:     (data.chat_rooms || []).filter(r => r.status === 'active').length,
      totalMatchReqs:  (data.match_requests || []).length,
      totalDisputes:   (data.disputes || []).length,
      totalReviews:    (data.reviews || []).length,
      totalAdmins:     (data.admins || []).length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/data/tasks — all tasks with full info
app.get('/api/admin/data/tasks', (req, res) => {
  try {
    const data = db.readDb();
    const tasks = (data.tasks || []).map(t => ({
      id:         t.id,
      title:      t.title,
      type:       t.type,
      status:     t.status,
      offering:   t.offering,
      wanting:    t.wanting,
      duration:   t.duration,
      posted_by:  t.posted_by,
      user_name:  t.user?.name || 'Unknown',
      created_at: t.created_at,
    }));
    res.json(tasks);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/data/sessions — all chat rooms / sessions
app.get('/api/admin/data/sessions', (req, res) => {
  try {
    const data = db.readDb();
    const sessions = (data.chat_rooms || []).map(r => ({
      id:           r.id,
      task_title:   r.task?.title || r.title || 'Session',
      participants: r.participants || [],
      status:       r.status || 'active',
      created_at:   r.created_at,
      message_count: (r.messages || []).length,
    }));
    res.json(sessions);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/data/disputes — all disputes / reports
app.get('/api/admin/data/disputes', (req, res) => {
  try {
    const data = db.readDb();
    const disputes = (data.disputes || []).map(d => ({
      id:          d.id,
      reporter:    d.reporter_name || d.reporter_id || 'Unknown',
      reported:    d.reported_name || d.reported_id || 'Unknown',
      reason:      d.reason || d.type || 'No reason provided',
      status:      d.status || 'open',
      priority:    d.priority || 'medium',
      created_at:  d.created_at,
    }));
    res.json(disputes);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/data/reviews — all reviews / payments
app.get('/api/admin/data/reviews', (req, res) => {
  try {
    const data = db.readDb();
    const reviews = (data.reviews || []).map(r => ({
      id:          r.id,
      reviewer:    r.reviewer_name || r.reviewer_id || 'Unknown',
      reviewed:    r.reviewed_name || r.reviewed_id || 'Unknown',
      rating:      r.rating,
      comment:     r.comment,
      created_at:  r.created_at,
    }));
    res.json(reviews);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/data/match-requests — all match requests
app.get('/api/admin/data/match-requests', (req, res) => {
  try {
    const data = db.readDb();
    res.json(data.match_requests || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Admin User Management ────────────────────────────────────────────────────
// Data sources:
//   Supabase  → profiles (id, name, email, role, profile_pic, updated_at)
//   Supabase  → user_skills (user_id, skill_name, skill_type, created_at)
//   Supabase  → tasks (user_id, title, status, offering, wanting, created_at, type)
//   Local DB  → reviews, disputes, rooms (chat sessions)
//   Local DB  → admin_user_settings (block / verify overrides)

function getAdminUserSettings() {
  const data = db.readDb();
  return data.admin_user_settings || {};
}

function saveAdminUserSettings(settings) {
  const data = db.readDb();
  data.admin_user_settings = settings;
  db.writeDb(data);
}

// Build one enriched user object from all data sources
function buildEnrichedUser(profile, sbSkills, sbTasks, localData, adminSettings) {
  const uid = profile.id;
  const ovr = adminSettings[uid] || {};

  // ── Skills: Supabase user_skills (real), fallback to local JSON ───────────
  let skills = sbSkills
    .filter(s => s.user_id === uid)
    .map(s => ({ name: s.skill_name, type: s.skill_type }));

  if (!skills.length) {
    skills = (localData.user_skills || [])
      .filter(s => s.user_id === uid)
      .map(s => ({ name: s.skill_name, type: s.skill_type }));
  }

  // ── Tasks: Supabase tasks (real), fallback to local JSON ──────────────────
  // Supabase tasks use user_id; local seed tasks use posted_by
  const sbUserTasks   = sbTasks.filter(t => t.user_id === uid);
  const localUserTasks = (localData.tasks || []).filter(t => t.posted_by === uid);
  const allTasks = sbUserTasks.length ? sbUserTasks : localUserTasks;

  // ── Reviews / disputes / rooms from local DB ──────────────────────────────
  const reviews  = (localData.reviews  || []).filter(r => r.target_user_id === uid || r.reviewed_id === uid);
  const disputes = (localData.disputes || []).filter(d => d.reported_id    === uid);
  const rooms    = (localData.rooms    || []).filter(r => (r.participants  || []).includes(uid));

  let msgCount = 0;
  rooms.forEach(room => {
    msgCount += (room.messages || []).filter(m => m.senderId === uid).length;
  });

  // ── Ratings ───────────────────────────────────────────────────────────────
  const ratingValues = reviews.map(r => r.rating || 0).filter(v => v > 0);
  const avgRating    = ratingValues.length
    ? ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length : 0;

  const feedbackList = reviews.map(r => ({
    rating:    r.rating    || 0,
    comment:   r.comment   || '',
    reviewer:  r.reviewer_name || r.reviewer_id || 'User',
    created_at: r.created_at,
  }));

  const reportList = disputes.map(d => ({
    id:        d.id,
    reporter:  d.reporter_name || d.reporter_id || 'User',
    reason:    d.reason || d.type || 'Reported',
    priority:  d.priority || 'medium',
    status:    d.status   || 'open',
    created_at: d.created_at,
  }));

  // ── joined_at: earliest task/skill created_at, else updated_at ───────────
  const timestamps = [
    ...allTasks.map(t => t.created_at),
    ...skills.filter(s => s.created_at).map(s => s.created_at),
  ].filter(Boolean).sort();
  const joinedAt = timestamps[0] || profile.updated_at || new Date().toISOString();

  return {
    id:                 uid,
    name:               profile.name  || profile.full_name || 'Unknown',
    email:              profile.email || '',
    role:               profile.role  || 'user',
    profile_pic:        profile.profile_pic || profile.avatar_url || null,
    joined_at:          joinedAt,
    last_active:        profile.updated_at || joinedAt,
    status:             ovr.blocked  ? 'blocked' : 'active',
    verified:           ovr.verified || false,
    skills,
    rating:             Math.round(avgRating * 10) / 10,
    ratings_count:      ratingValues.length,
    projects_completed: allTasks.filter(t => ['completed','exchanged','done'].includes(t.status)).length,
    total_projects:     allTasks.length,
    messages_count:     msgCount,
    sessions_count:     rooms.length,
    reports_count:      reportList.length,
    is_suspicious:      reportList.length >= 2,
    has_reports:        reportList.length > 0,
    feedback:           feedbackList,
    reports:            reportList,
    // Extra task detail for the detail modal
    tasks: allTasks.slice(0, 20).map(t => ({
      id:         t.id,
      title:      t.title    || t.offering || 'Untitled',
      status:     t.status   || 'open',
      offering:   t.offering || '',
      wanting:    t.wanting  || '',
      type:       t.type     || 'direct',
      created_at: t.created_at,
    })),
  };
}

// GET /api/admin/users  — real Supabase data + local enrichment
app.get('/api/admin/users', async (req, res) => {
  try {
    const localData = db.readDb();
    const adminSettings = getAdminUserSettings();

    // ── Fetch from Supabase in parallel ───────────────────────────────────
    let sbProfiles = [], sbSkills = [], sbTasks = [];

    if (supabase) {
      const [pRes, sRes, tRes] = await Promise.allSettled([
        supabase.from('profiles')
          .select('id, name, email, role, profile_pic, updated_at')
          .order('updated_at', { ascending: false }),

        supabase.from('user_skills')
          .select('id, user_id, skill_name, skill_type, created_at'),

        supabase.from('tasks')
          .select('id, user_id, title, status, offering, wanting, type, created_at, updated_at'),
      ]);

      if (pRes.status === 'fulfilled' && !pRes.value.error) {
        sbProfiles = pRes.value.data || [];
        console.log(`[admin/users] ${sbProfiles.length} profiles from Supabase`);
      } else {
        console.warn('[admin/users] profiles fetch failed:', pRes.reason || pRes.value?.error?.message);
      }

      if (sRes.status === 'fulfilled' && !sRes.value.error) sbSkills = sRes.value.data || [];
      if (tRes.status === 'fulfilled' && !tRes.value.error) sbTasks  = tRes.value.data || [];

      console.log(`[admin/users] ${sbSkills.length} skills, ${sbTasks.length} tasks from Supabase`);
    }

    // ── Use seed profiles only when Supabase returned nothing ─────────────
    const profiles = sbProfiles.length ? sbProfiles : [
      { id: 'seed-user-1', name: 'Arjun Mehta',  email: 'arjun@skillswap.demo',  role: 'both',       updated_at: new Date(Date.now() -  2*3600000).toISOString() },
      { id: 'seed-user-2', name: 'Priya Sharma', email: 'priya@skillswap.demo',  role: 'freelancer', updated_at: new Date(Date.now() -  5*3600000).toISOString() },
      { id: 'seed-user-3', name: 'Neha Kapoor',  email: 'neha@skillswap.demo',   role: 'client',     updated_at: new Date(Date.now() -  8*3600000).toISOString() },
      { id: 'seed-user-4', name: 'Rohan Verma',  email: 'rohan@skillswap.demo',  role: 'both',       updated_at: new Date(Date.now() - 12*3600000).toISOString() },
      { id: 'seed-user-5', name: 'Carlos Ruiz',  email: 'carlos@skillswap.demo', role: 'freelancer', updated_at: new Date(Date.now() - 24*3600000).toISOString() },
      { id: 'seed-user-6', name: 'Kavita Singh', email: 'kavita@skillswap.demo', role: 'client',     updated_at: new Date(Date.now() - 48*3600000).toISOString() },
    ];

    // ── Build enriched list ────────────────────────────────────────────────
    const enriched = profiles.map(p =>
      buildEnrichedUser(p, sbSkills, sbTasks, localData, adminSettings)
    );

    res.json({
      users:            enriched,
      total:            enriched.length,
      active_count:     enriched.filter(u => u.status  === 'active').length,
      blocked_count:    enriched.filter(u => u.status  === 'blocked').length,
      verified_count:   enriched.filter(u => u.verified).length,
      suspicious_count: enriched.filter(u => u.is_suspicious).length,
      supabase_users:   sbProfiles.length,
    });
  } catch (err) {
    console.error('[admin/users] Unhandled error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/users/:id  — single user, full detail
app.get('/api/admin/users/:id', async (req, res) => {
  try {
    const { id }    = req.params;
    const localData = db.readDb();
    const adminSettings = getAdminUserSettings();

    let profile = null, sbSkills = [], sbTasks = [];

    if (supabase) {
      const [pRes, sRes, tRes] = await Promise.allSettled([
        supabase.from('profiles')
          .select('id, name, email, role, profile_pic, updated_at')
          .eq('id', id).single(),

        supabase.from('user_skills')
          .select('id, user_id, skill_name, skill_type, created_at')
          .eq('user_id', id),

        supabase.from('tasks')
          .select('id, user_id, title, status, offering, wanting, type, created_at, updated_at')
          .eq('user_id', id)
          .order('created_at', { ascending: false }),
      ]);

      if (pRes.status === 'fulfilled' && !pRes.value.error) profile = pRes.value.data;
      if (sRes.status === 'fulfilled' && !sRes.value.error) sbSkills = sRes.value.data || [];
      if (tRes.status === 'fulfilled' && !tRes.value.error) sbTasks  = tRes.value.data || [];
    }

    // Fallback: local DB user or seed
    if (!profile) {
      profile = (localData.users || []).find(u => u.id === id)
        || [
          { id: 'seed-user-1', name: 'Arjun Mehta',  email: 'arjun@skillswap.demo',  role: 'both',       updated_at: new Date().toISOString() },
          { id: 'seed-user-2', name: 'Priya Sharma', email: 'priya@skillswap.demo',  role: 'freelancer', updated_at: new Date().toISOString() },
          { id: 'seed-user-3', name: 'Neha Kapoor',  email: 'neha@skillswap.demo',   role: 'client',     updated_at: new Date().toISOString() },
          { id: 'seed-user-4', name: 'Rohan Verma',  email: 'rohan@skillswap.demo',  role: 'both',       updated_at: new Date().toISOString() },
          { id: 'seed-user-5', name: 'Carlos Ruiz',  email: 'carlos@skillswap.demo', role: 'freelancer', updated_at: new Date().toISOString() },
          { id: 'seed-user-6', name: 'Kavita Singh', email: 'kavita@skillswap.demo', role: 'client',     updated_at: new Date().toISOString() },
        ].find(s => s.id === id);
    }

    if (!profile) return res.status(404).json({ error: 'User not found' });

    res.json(buildEnrichedUser(profile, sbSkills, sbTasks, localData, adminSettings));
  } catch (err) {
    console.error('[admin/users/:id] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/users/:id/block
app.patch('/api/admin/users/:id/block', (req, res) => {
  try {
    const { id } = req.params;
    const { blocked } = req.body;
    const settings = getAdminUserSettings();
    settings[id] = { ...(settings[id] || {}), blocked: !!blocked, blocked_at: blocked ? new Date().toISOString() : null };
    saveAdminUserSettings(settings);
    res.json({ success: true, blocked: !!blocked });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/admin/users/:id/verify
app.patch('/api/admin/users/:id/verify', (req, res) => {
  try {
    const { id } = req.params;
    const { verified } = req.body;
    const settings = getAdminUserSettings();
    settings[id] = { ...(settings[id] || {}), verified: !!verified, verified_at: verified ? new Date().toISOString() : null };
    saveAdminUserSettings(settings);
    res.json({ success: true, verified: !!verified });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── REPORTING & MODERATION ROUTES ───────────────────────────────────────────

// Stub email notifier — plug in Resend / SendGrid here for v2
function sendAdminEmail(subject, body) {
  console.log(`[EMAIL STUB] To: admin | Subject: ${subject}\n${body}`);
}

const REASON_CATEGORIES = [
  'Harassment / Hate speech',
  'Spam or scam',
  'Inappropriate content',
  'Impersonation',
  'Sharing personal info',
  'Threatening behavior',
  'Other',
];

// POST /api/reports — submit a user report
app.post('/api/reports', async (req, res) => {
  try {
    const { reporter_id, reported_user_id, chat_room_id, reason_category, description, evidence_message_ids } = req.body;

    // Validation
    if (!reporter_id || !reported_user_id || !reason_category || !description)
      return res.status(400).json({ error: 'reporter_id, reported_user_id, reason_category, and description are required' });

    if (reporter_id === reported_user_id)
      return res.status(400).json({ error: 'You cannot report yourself' });

    if (!REASON_CATEGORIES.includes(reason_category))
      return res.status(400).json({ error: 'Invalid reason_category' });

    if (description.length < 20 || description.length > 1000)
      return res.status(400).json({ error: 'Description must be 20–1000 characters' });

    // ── 1. Always Save Locally (Source of Truth for the local app) ─────────
    const localReport = db.saveReport({
      reporter_id,
      reported_user_id,
      chat_room_id: chat_room_id || null,
      reason_category,
      description,
      evidence_message_ids: evidence_message_ids || [],
      is_local: true,
      sync_status: 'pending'
    });

    // ── 2. Background Supabase Sync (Optional & Non-Blocking) ──────────────
    let sbReport = null;
    if (supabase) {
      // We don't 'await' the full process if we want to be truly non-blocking,
      // but for now we await to give it a chance, but catch all errors.
      try {
        const { data, error: insertErr } = await supabase
          .from('reports')
          .insert({
            reporter_id,
            reported_user_id,
            chat_room_id: chat_room_id || null,
            reason_category,
            description,
            evidence_message_ids: evidence_message_ids || [],
            status: 'pending',
          })
          .select(); // Use select() instead of .single() to be safer if RLS blocks
        
        if (insertErr) {
          console.warn('⚠️  Supabase Sync Warning (RLS likely):', insertErr.message);
        } else if (data && data.length > 0) {
          sbReport = data[0];
          // Update local report to show it's synced
          localReport.sync_status = 'synced';
          localReport.sb_id = sbReport.id;
        }
      } catch (e) {
        console.warn('⚠️  Supabase Sync Exception:', e.message);
      }
    }

    // ── 3. Notification & Logic ───────────────────────────────────────────
    const localDbData = db.readDb();
    const reportsAgainstUser = (localDbData.reports || []).filter(r => 
      r.reported_user_id === reported_user_id && ['pending', 'under_review'].includes(r.status)
    );
    const distinctReporters = new Set(reportsAgainstUser.map(r => r.reporter_id)).size;

    const report = sbReport || localReport;
    const notifContent = distinctReporters >= 3
      ? `🚨 AUTO-FLAG: ${reported_user_id} now has ${distinctReporters} distinct reporters — review required.`
      : `New report filed against user ${reported_user_id} (${reason_category}).`;

    io.emit('admin:new_report', { report, distinctReporters, autoFlag: distinctReporters >= 3 });
    sendAdminEmail('New User Report — ShareSphere', notifContent);

    // Persist notification for admin users in local DB
    (localDbData.admins || []).forEach(admin => {
      db.addNotification({
        user_id: admin.id || admin.email,
        content: notifContent,
        type: 'admin_report',
        reference_id: report.id,
        task_id: null,
      });
    });

    // ALWAYS return 200 Success if it was saved locally
    res.json({ success: true, report: localReport });
  } catch (err) {
    console.error('❌ [POST /api/reports] Critical Error:', err.message);
    res.status(500).json({ error: 'Internal server error occurred while processing report.' });
  }
});

// GET /api/admin/reports — list all reports with optional filters
app.get('/api/admin/reports', async (req, res) => {
  try {
    const { status, reason_category, date_from, date_to } = req.query;
    let reports = [];

    // ── 1. Fetch Supabase reports ──────────────────────────────────────────
    if (supabase) {
      try {
        let query = supabase
          .from('reports')
          .select('id, reporter_id, reported_user_id, chat_room_id, reason_category, description, status, created_at, updated_at')
          .order('created_at', { ascending: false });

        if (status)          query = query.eq('status', status);
        if (reason_category) query = query.eq('reason_category', reason_category);
        if (date_from)       query = query.gte('created_at', date_from);
        if (date_to)         query = query.lte('created_at', date_to);

        const { data, error } = await query;
        if (!error) reports = data || [];
      } catch (e) { console.warn('[reports] Supabase fetch failed:', e.message); }
    }

    // ── 2. Merge Local Reports & Disputes ──────────────────────────────────
    const localDbData = db.readDb();
    
    const localReports = (localDbData.reports || []).map(r => ({ ...r, is_local: true }));
    
    const localDisputes = (localDbData.disputes || []).map(d => {
      const room = (localDbData.rooms || []).find(r => r.id === d.room_id);
      const reportedId = room?.participants?.find(uid => uid !== d.raised_by);
      return {
        id: d.id,
        reporter_id: d.raised_by,
        reported_user_id: reportedId || null,
        chat_room_id: d.room_id,
        reason_category: d.reason || 'Exchange Dispute',
        description: d.description,
        status: d.status || 'pending',
        created_at: d.created_at,
        is_local: true
      };
    });

    const allReports = [...reports, ...localReports, ...localDisputes]
      .filter(d => {
        if (status && d.status !== status) return false;
        if (reason_category && d.reason_category !== reason_category) return false;
        if (date_from && d.created_at < date_from) return false;
        if (date_to && d.created_at > date_to) return false;
        return true;
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // ── 3. Enrich Profiles (Supabase + Local Fallback) ──────────────────────
    const allIds = [...new Set([
      ...allReports.map(r => r.reporter_id),
      ...allReports.map(r => r.reported_user_id),
    ].filter(Boolean))];

    const profileMap = {};
    if (allIds.length > 0) {
      if (supabase) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, name, email, profile_pic, status, warning_count')
          .in('id', allIds);
        (profiles || []).forEach(p => { profileMap[p.id] = p; });
      }
      // Local fallback for IDs not found in Supabase
      allIds.forEach(id => {
        if (!profileMap[id]) {
          const localUser = (localDbData.users || []).find(u => u.id === id);
          if (localUser) {
            profileMap[id] = {
              id: localUser.id,
              name: localUser.name,
              email: localUser.email,
              profile_pic: localUser.avatar_url || null,
              status: localUser.status || 'active',
              warning_count: localUser.warning_count || 0
            };
          }
        }
      });
    }

    // ── 4. Distinct Reporter Counts (Optimized) ─────────────────────────────
    // Instead of querying per-user, we use the already-fetched report list for local counts
    // and a single query for global pending counts if needed.
    const countMap = {};
    const reportedIds = [...new Set(allReports.map(r => r.reported_user_id).filter(Boolean))];
    
    // Simple count based on CURRENT list (good for local-first)
    reportedIds.forEach(uid => {
      const distinctReporters = new Set(
        allReports
          .filter(r => r.reported_user_id === uid && ['pending', 'under_review'].includes(r.status))
          .map(r => r.reporter_id)
      );
      countMap[uid] = distinctReporters.size;
    });

    const enriched = allReports.map(r => ({
      ...r,
      reporter: profileMap[r.reporter_id] || null,
      reported: profileMap[r.reported_user_id] || null,
      distinct_reporter_count: countMap[r.reported_user_id] || 0,
    }));

    res.json(enriched);
  } catch (err) {
    console.error('[GET /api/admin/reports] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/reports/:id — full detail: profiles, chat history, prior reports, moderation history
app.get('/api/admin/reports/:id', async (req, res) => {
  try {
    const localDbData = db.readDb();
    let report = null;

    // ── 1. Fetch plain report (Supabase then Local Fallback) ───────────────
    if (supabase) {
      const { data, error } = await supabase.from('reports').select('*').eq('id', req.params.id).single();
      if (!error) report = data;
    }

    if (!report) {
      const localReport = (localDbData.reports || []).find(r => r.id === req.params.id);
      if (localReport) {
        report = { ...localReport, is_local: true };
      } else {
        const localDispute = (localDbData.disputes || []).find(d => d.id === req.params.id);
        if (localDispute) {
          const room = (localDbData.rooms || []).find(r => r.id === localDispute.room_id);
          const reportedId = room?.participants?.find(uid => uid !== localDispute.raised_by);
          report = {
            id: localDispute.id,
            reporter_id: localDispute.raised_by,
            reported_user_id: reportedId || null,
            chat_room_id: localDispute.room_id,
            reason_category: localDispute.reason || 'Exchange Dispute',
            description: localDispute.description,
            status: localDispute.status || 'pending',
            created_at: localDispute.created_at,
            is_local: true
          };
        }
      }
    }

    if (!report) return res.status(404).json({ error: 'Report not found' });

    // ── 2. Fetch profiles (Supabase + Local Fallback) ─────────────────────
    const fetchProfile = async (uid) => {
      if (!uid) return null;
      if (supabase) {
        const { data, error } = await supabase.from('profiles').select('*').eq('id', uid).single();
        if (!error && data) return data;
      }
      const localUser = (localDbData.users || []).find(u => u.id === uid);
      if (localUser) {
        return {
          id: localUser.id,
          name: localUser.name,
          email: localUser.email,
          profile_pic: localUser.avatar_url || null,
          status: localUser.status || 'active',
          warning_count: localUser.warning_count || 0,
          created_at: localUser.created_at
        };
      }
      return null;
    };

    const [reporter, reported] = await Promise.all([
      fetchProfile(report.reporter_id),
      fetchProfile(report.reported_user_id)
    ]);
    report.reporter = reporter;
    report.reported = reported;

    // ── 3. Chat history: try local DB first ────────────────────────────────
    let chatHistory = [];
    if (report.chat_room_id) {
      const localRoom = (localDbData.rooms || []).find(r => r.id === report.chat_room_id);
      if (localRoom && Array.isArray(localRoom.messages) && localRoom.messages.length > 0) {
        chatHistory = localRoom.messages.slice(-200).map(m => ({
          id:          m.id,
          sender_id:   m.senderId || m.sender_id,
          sender_name: m.senderName || m.sender_name || 'User',
          content:     m.content,
          created_at:  m.created_at || m.timestamp,
        }));
      } else if (supabase) {
        // Fallback: try Supabase chat_messages table
        try {
          const { data: msgs } = await supabase
            .from('chat_messages')
            .select('id, sender_id, sender_name, content, created_at')
            .eq('room_id', report.chat_room_id)
            .order('created_at', { ascending: true })
            .limit(200);
          chatHistory = msgs || [];
        } catch { /* table may not exist */ }
      }
    }

    // Prior reports AGAINST the reported user
    const { data: priorReports } = await supabase
      .from('reports')
      .select('id, reason_category, status, created_at')
      .eq('reported_user_id', report.reported_user_id)
      .neq('id', report.id)
      .order('created_at', { ascending: false });

    // Moderation history — merge Supabase (legacy) + local DB (current)
    const { data: supabaseActions } = await supabase
      .from('moderation_actions')
      .select('*')
      .eq('report_id', report.id)
      .order('created_at', { ascending: false });
    const localActions = db.getModerationActionsForReport(report.id);
    const actions = [...(supabaseActions || []), ...localActions]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Distinct reporter count
    const { data: allUserReports } = await supabase
      .from('reports')
      .select('reporter_id')
      .eq('reported_user_id', report.reported_user_id)
      .in('status', ['pending', 'under_review']);
    const distinctReporterCount = new Set((allUserReports || []).map(r => r.reporter_id)).size;

    // Reporter's own filing count (how many reports they have filed total)
    const { count: reporterFiledCount } = await supabase
      .from('reports')
      .select('id', { count: 'exact', head: true })
      .eq('reporter_id', report.reporter_id);

    res.json({
      report,
      chatHistory,
      priorReports: priorReports || [],
      moderationActions: actions || [],
      distinctReporterCount,
      reporterFiledCount: reporterFiledCount || 0,
    });
  } catch (err) {
    console.error('[GET /api/admin/reports/:id] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/reports/:id/action — dismiss / warn / temp_ban / permanent_ban
app.post('/api/admin/reports/:id/action', async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });

    // Validate report ID is a valid UUID before hitting the DB
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid report ID format' });
    }

    const { action_type, admin_note, duration_days } = req.body;
    const adminEmail = req.body.admin_email || 'admin';

    if (!action_type || !admin_note)
      return res.status(400).json({ error: 'action_type and admin_note are required' });

    const validActions = ['dismiss', 'warn', 'temp_ban', 'permanent_ban'];
    if (!validActions.includes(action_type))
      return res.status(400).json({ error: 'Invalid action_type' });

    if (action_type === 'temp_ban' && (!duration_days || duration_days <= 0))
      return res.status(400).json({ error: 'duration_days required for temp_ban' });

    // Fetch report from Supabase
    const { data: report, error: repErr } = await supabase
      .from('reports').select('*').eq('id', req.params.id).single();
    if (repErr || !report) return res.status(404).json({ error: 'Report not found' });

    const targetId = report.reported_user_id;

    // ── Store moderation action in LOCAL DB only ───────────────────────────
    // This avoids the Supabase `moderation_actions.admin_id` FK constraint
    // which requires a UUID from the `profiles` table. Local admins are not
    // Supabase auth users, so we never touch that Supabase table for actions.
    const action = db.addModerationAction({
      report_id:       req.params.id,
      admin_id:        null, // local admin — no Supabase profile ID
      admin_email:     adminEmail,
      target_user_id:  targetId,
      action_type,
      duration_days:   action_type === 'temp_ban' ? Number(duration_days) : null,
      admin_note:      `[${adminEmail}] ${admin_note}`,
    });

    // ── Update report status in Supabase ─────────────────────────────────
    const newReportStatus = action_type === 'dismiss' ? 'dismissed' : 'resolved';
    const { error: updateErr } = await supabase
      .from('reports')
      .update({ status: newReportStatus, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (updateErr) console.warn('[action] report status update failed:', updateErr.message);

    // ── Apply profile changes in Supabase ─────────────────────────────────
    let profileUpdate = {};
    let userNotifContent = null;

    if (action_type === 'warn') {
      const { data: prof } = await supabase
        .from('profiles').select('warning_count').eq('id', targetId).single();
      profileUpdate = { status: 'warned', warning_count: (prof?.warning_count || 0) + 1 };
      userNotifContent = `⚠️ You have received an official warning from ShareSphere moderation. Reason: ${report.reason_category}. Continued violations may result in a ban.`;
    } else if (action_type === 'temp_ban') {
      const expiresAt = new Date(Date.now() + Number(duration_days) * 86400000).toISOString();
      profileUpdate = { status: 'temp_banned', ban_expires_at: expiresAt };
      userNotifContent = `🚫 Your account has been temporarily suspended for ${duration_days} day(s). Reason: ${report.reason_category}.`;
    } else if (action_type === 'permanent_ban') {
      profileUpdate = { status: 'permanent_banned', ban_expires_at: null };
      userNotifContent = `🚫 Your account has been permanently suspended. Reason: ${report.reason_category}.`;
    }

    if (Object.keys(profileUpdate).length > 0) {
      const { error: profErr } = await supabase
        .from('profiles').update(profileUpdate).eq('id', targetId);
      if (profErr) console.warn('[action] profile update failed:', profErr.message);
    }

    // ── In-app notification for the reported user ─────────────────────────
    if (userNotifContent) {
      db.addNotification({
        user_id:      targetId,
        content:      userNotifContent,
        type:         'moderation',
        reference_id: req.params.id,
        task_id:      null,
      });
      io.to(targetId).emit('notification:new', {
        id:      Date.now().toString(),
        content: userNotifContent,
        type:    'moderation',
      });
      sendAdminEmail(`ShareSphere Moderation — ${action_type}`,
        `Action: ${action_type} | Target: ${targetId} | By: ${adminEmail} | Note: ${admin_note}`);
    }

    res.json({ success: true, action, reportStatus: newReportStatus });
  } catch (err) {
    console.error('[POST /api/admin/reports/:id/action] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users/:userId/ban-status — used by auth-context on login
app.get('/api/users/:userId/ban-status', async (req, res) => {
  try {
    if (!supabase) return res.json({ banned: false });

    const { data: profile } = await supabase
      .from('profiles')
      .select('status, ban_expires_at, warning_count')
      .eq('id', req.params.userId)
      .single();

    if (!profile) return res.json({ banned: false });

    const { status, ban_expires_at, warning_count } = profile;

    if (status === 'permanent_banned')
      return res.json({ banned: true, type: 'permanent', reason: 'permanent_banned', warning_count });

    if (status === 'temp_banned') {
      const expired = ban_expires_at && new Date(ban_expires_at) < new Date();
      if (expired) {
        // Auto-lift expired temp bans
        await supabase.from('profiles').update({ status: 'active', ban_expires_at: null }).eq('id', req.params.userId);
        return res.json({ banned: false });
      }
      return res.json({ banned: true, type: 'temp', ban_expires_at, warning_count });
    }

    res.json({ banned: false, status, warning_count });
  } catch (err) {
    console.error('[GET /api/users/:userId/ban-status] Error:', err.message);
    res.json({ banned: false }); // fail open — don't lock out on server error
  }
});

// GET /api/users/:userId/flag-status — 3-color flag system for profile pages
// Level 0 (none):   clean account
// Level 1 (yellow): 1–2 reports OR status='warned'
// Level 2 (orange): 3+ distinct reporters (auto-flag threshold)
// Level 3 (red):    temp_banned or permanent_banned
app.get('/api/users/:userId/flag-status', async (req, res) => {
  try {
    if (!supabase) return res.json({ level: 0, color: 'none', count: 0, label: '' });

    const [{ data: profile }, { data: reports }] = await Promise.all([
      supabase.from('profiles').select('status, warning_count').eq('id', req.params.userId).single(),
      supabase.from('reports').select('reporter_id').eq('reported_user_id', req.params.userId)
        .in('status', ['pending', 'under_review']),
    ]);

    const status = profile?.status || 'active';
    const distinctCount = new Set((reports || []).map(r => r.reporter_id)).size;

    let level = 0, color = 'none', label = '';

    if (status === 'permanent_banned') {
      level = 3; color = 'red'; label = 'Permanently suspended';
    } else if (status === 'temp_banned') {
      level = 3; color = 'red'; label = 'Temporarily suspended';
    } else if (distinctCount >= 3) {
      level = 2; color = 'orange'; label = `${distinctCount} reports — flagged`;
    } else if (distinctCount >= 1 || status === 'warned') {
      level = 1; color = 'yellow'; label = status === 'warned'
        ? `Warning issued${distinctCount > 0 ? ` · ${distinctCount} report` : ''}`
        : `${distinctCount} report${distinctCount > 1 ? 's' : ''}`;
    }

    res.json({ level, color, label, count: distinctCount, status, warning_count: profile?.warning_count || 0 });
  } catch (err) {
    console.error('[GET /api/users/:userId/flag-status] Error:', err.message);
    res.json({ level: 0, color: 'none', count: 0, label: '' });
  }
});

// ─── Supabase → Local DB Sync ─────────────────────────────────────────────────
// Runs at startup (and on demand) to pull real user data from Supabase into the
// local JSON DB so all existing routes that read from localDb work correctly.
async function syncFromSupabase() {
  if (!supabase) {
    console.warn('[sync] Supabase client not available — skipping sync');
    return { synced: false, reason: 'no supabase client' };
  }
  try {
    console.log('[sync] Starting Supabase → local DB sync...');
    const dbData = db.readDb();
    let changed = false;

    // ── 1. Sync tasks ────────────────────────────────────────────────────────
    const { data: sbTasks, error: taskErr } = await supabase
      .from('tasks')
      .select('id, title, description, offering, wanting, type, duration, schedule, status, user_id, created_at');

    if (taskErr) console.warn('[sync] tasks fetch error:', taskErr.message);
    if (sbTasks && sbTasks.length > 0) {
      const userIds = [...new Set(sbTasks.map(t => t.user_id).filter(Boolean))];
      let profileMap = {};
      if (userIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles').select('id, name, profile_pic').in('id', userIds);
        (profiles || []).forEach(p => { profileMap[p.id] = p; });
      }

      const localIds = new Set(dbData.tasks.map(t => t.id));
      for (const t of sbTasks) {
        if (localIds.has(t.id)) {
          const local = dbData.tasks.find(lt => lt.id === t.id);
          if (local && local.status !== t.status) { local.status = t.status; changed = true; }
          continue;
        }
        const profile = profileMap[t.user_id] || {};
        dbData.tasks.push({
          id:          t.id,
          title:       t.title || '',
          description: t.description || '',
          offering:    Array.isArray(t.offering) ? t.offering : (t.offering ? [t.offering] : []),
          wanting:     Array.isArray(t.wanting)  ? t.wanting  : (t.wanting  ? [t.wanting]  : []),
          type:        t.type     || 'direct',
          duration:    t.duration || '1 hour',
          schedule:    t.schedule || 'Anytime',
          status:      t.status   || 'open',
          posted_by:   t.user_id,
          user:        { name: profile.name || 'User', avatar_url: profile.profile_pic || null },
          created_at:  t.created_at || new Date().toISOString(),
        });
        changed = true;
      }
      console.log(`[sync] tasks: ${sbTasks.length} from Supabase, ${dbData.tasks.length} now in local DB`);
    }

    // ── 2. Sync task_requests ────────────────────────────────────────────────
    const { data: sbReqs, error: reqErr } = await supabase
      .from('task_requests')
      .select('id, task_id, requester_id, owner_id, status, created_at');

    if (reqErr) console.warn('[sync] task_requests fetch error:', reqErr.message);
    if (sbReqs && sbReqs.length > 0) {
      if (!dbData.requests) dbData.requests = [];
      const localReqIds = new Set(dbData.requests.map(r => r.id));

      const reqUserIds = [...new Set([
        ...sbReqs.map(r => r.requester_id),
        ...sbReqs.map(r => r.owner_id)
      ].filter(Boolean))];
      let reqProfileMap = {};
      if (reqUserIds.length > 0) {
        const { data: reqProfiles } = await supabase
          .from('profiles').select('id, name, profile_pic').in('id', reqUserIds);
        (reqProfiles || []).forEach(p => { reqProfileMap[p.id] = p; });
      }

      for (const r of sbReqs) {
        if (localReqIds.has(r.id)) {
          const local = dbData.requests.find(lr => lr.id === r.id);
          if (local && local.status !== r.status) { local.status = r.status; changed = true; }
          continue;
        }
        const task = dbData.tasks.find(t => t.id === r.task_id);
        const rp = reqProfileMap[r.requester_id] || {};
        const op = reqProfileMap[r.owner_id]     || {};
        dbData.requests.push({
          id:             r.id,
          task_id:        r.task_id || null,
          requested_by:   r.requester_id,
          target_user_id: r.owner_id,
          status:         r.status || 'pending',
          message:        '',
          requester: { name: rp.name || 'User', avatar_url: rp.profile_pic || null },
          owner:     { name: op.name || 'User', avatar_url: op.profile_pic || null },
          task: task ? { ...task } : {
            id: r.task_id, title: 'Skill Exchange',
            posted_by: r.owner_id, offering: '', wanting: ''
          },
          created_at: r.created_at || new Date().toISOString(),
        });
        changed = true;
      }
      console.log(`[sync] requests: ${sbReqs.length} from Supabase, ${dbData.requests.length} now in local DB`);
    }

    // ── 3. Sync chat_rooms ───────────────────────────────────────────────────
    const { data: sbRooms, error: roomErr } = await supabase
      .from('chat_rooms')
      .select('id, task_id, user_a, user_b, status, created_at');

    if (roomErr) console.warn('[sync] chat_rooms fetch error:', roomErr.message);
    if (sbRooms && sbRooms.length > 0) {
      if (!dbData.rooms) dbData.rooms = [];
      const localRoomIds = new Set(dbData.rooms.map(r => r.id));

      const roomUserIds = [...new Set(sbRooms.flatMap(r => [r.user_a, r.user_b]).filter(Boolean))];
      let roomProfileMap = {};
      if (roomUserIds.length > 0) {
        const { data: roomProfiles } = await supabase
          .from('profiles').select('id, name, profile_pic').in('id', roomUserIds);
        (roomProfiles || []).forEach(p => { roomProfileMap[p.id] = p; });
      }

      for (const r of sbRooms) {
        if (localRoomIds.has(r.id)) continue;
        const pA = roomProfileMap[r.user_a] || {};
        const pB = roomProfileMap[r.user_b] || {};
        dbData.rooms.push({
          id:           r.id,
          task_id:      r.task_id || null,
          participants: [r.user_a, r.user_b],
          participant_info: {
            [r.user_a]: { name: pA.name || 'User', avatar_url: pA.profile_pic || null },
            [r.user_b]: { name: pB.name || 'User', avatar_url: pB.profile_pic || null },
          },
          status:            r.status || 'active',
          connected:         false,
          connection_clicks: [],
          messages:          [],
          created_at:        r.created_at || new Date().toISOString(),
          last_message:      null,
        });
        changed = true;
      }
      console.log(`[sync] rooms: ${sbRooms.length} from Supabase, ${dbData.rooms.length} now in local DB`);
    }

    if (changed) {
      db.writeDb(dbData);
      console.log('[sync] ✅ Local DB updated from Supabase');
    } else {
      console.log('[sync] ✔️  Local DB already up to date');
    }
    return { synced: true, changed };
  } catch (err) {
    console.error('[sync] Error during Supabase sync:', err.message);
    return { synced: false, error: err.message };
  }
}

// Run sync immediately at startup (non-blocking)
syncFromSupabase();

// Expose as an API endpoint for manual on-demand refresh
app.post('/api/sync-from-supabase', async (req, res) => {
  const result = await syncFromSupabase();
  res.json(result);
});

// ─── SERVER START ─────────────────────────────────────────────────────────────
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
