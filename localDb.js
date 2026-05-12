const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, 'tasks_db.json');

// No seed data — all content comes from real users



function initDb() {
  const SEED_USER_IDS = ['seed-user-1','seed-user-2','seed-user-3','seed-user-4','seed-user-5','seed-user-6'];

  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({
      tasks: [],
      requests: [],
      rooms: [],
      notifications: [],
      ratings: [],
      broadcasts: [],
      broadcast_requests: [],
      broadcast_enrollments: [],
      credit_transactions: [],
      connection_stages: [],
      reviews: [],
      disputes: [],
      users: [],
      user_skills: [],
      match_requests: [],
      reports: [],
      projects: [],
      project_requests: [],
      project_rooms: [],
      admins: [
        {
          id: '1',
          email: 'admin@sharesphere.com',
          password: '$2b$10$LYYN29oBaztOEKpKWyb.JegXXbQaoo.GRXep.SOGL8tCMDzdb6F5C',
          name: 'Super Admin',
          role: 'super_admin',
          avatar: null,
          phone: '+91 9000000001',
          department: 'Platform Management',
          permissions: ['all'],
          last_login: null,
          created_at: new Date().toISOString()
        },
        {
          id: '2',
          email: 'sriraj@sharesphere.com',
          password: '$2b$10$NuUzM7QzbsLTjbO.19ZcmeikL5eYEZAOOfDZpo1fyw.iwSdelbs.2',
          name: 'Sri Raj',
          role: 'super_admin',
          avatar: null,
          phone: '+91 9000000002',
          department: 'Engineering',
          permissions: ['all'],
          last_login: null,
          created_at: new Date().toISOString()
        },
        {
          id: '3',
          email: 'moderator@sharesphere.com',
          password: '$2b$10$V1o60PS4ljO4gzEyDIqpr.vdQd6Qx/Oy4cb/EDerkFXEYN.ykiuMe',
          name: 'Moderator',
          role: 'moderator',
          avatar: null,
          phone: '+91 9000000003',
          department: 'Trust & Safety',
          permissions: ['users', 'reports', 'sessions'],
          last_login: null,
          created_at: new Date().toISOString()
        }
      ]
    }, null, 2));
    console.log('📦 Local DB initialised (empty — no seed data):', DB_PATH);
  } else {
    // Migrate existing DB: strip any leftover demo/seed data
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    let changed = false;

    if (!db.user_skills) { db.user_skills = []; changed = true; }
    if (!db.match_requests) { db.match_requests = []; changed = true; }

    // Remove seed tasks
    const tasksBefore = (db.tasks || []).length;
    db.tasks = (db.tasks || []).filter(t => !SEED_USER_IDS.includes(t.posted_by));
    if (db.tasks.length !== tasksBefore) changed = true;

    // Remove seed skills
    const skillsBefore = db.user_skills.length;
    db.user_skills = db.user_skills.filter(s => !SEED_USER_IDS.includes(s.user_id));
    if (db.user_skills.length !== skillsBefore) changed = true;

    if (changed) {
      fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
      console.log('🧹 Removed demo seed data from existing DB');
    }
  }
}

function readDb() {
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  const db = JSON.parse(raw);
  let changed = false;
  const keys = [
    'rooms', 'notifications', 'ratings', 'broadcasts', 'broadcast_requests',
    'broadcast_enrollments', 'credit_transactions', 'broadcast_rooms',
    'connection_stages', 'reviews', 'disputes', 'users', 'user_skills', 'match_requests', 'admins',
    'moderation_actions', 'reports', 'projects', 'project_requests', 'project_rooms'
  ];
  if (!db.admins) {
    db.admins = [];
    changed = true;
  }

  // Enforce/Repair Super Admin
  const defaultAdmin = {
    id: '1',
    email: 'admin@sharesphere.com',
    password: '$2b$10$LYYN29oBaztOEKpKWyb.JegXXbQaoo.GRXep.SOGL8tCMDzdb6F5C', // Admin@123
    name: 'Super Admin',
    role: 'super_admin',
    department: 'Platform Management',
    permissions: ['all'],
    created_at: new Date().toISOString()
  };

  const adminIdx = db.admins.findIndex(a => a.email?.toLowerCase() === 'admin@sharesphere.com');
  if (adminIdx === -1) {
    db.admins.push(defaultAdmin);
    changed = true;
  } else {
    // If password doesn't match the hardcoded one, reset it to ensure login works
    if (db.admins[adminIdx].password !== defaultAdmin.password) {
      db.admins[adminIdx].password = defaultAdmin.password;
      changed = true;
    }
  }
  
  keys.forEach(k => {
    if (!db[k]) { db[k] = []; changed = true; }
  });
  if (changed) fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  return db;
}

function writeDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ─── Tasks ────────────────────────────────────────────────────────────────────
function getAllTasks({ excludeUserId } = {}) {
  const db = readDb();
  let tasks = db.tasks.filter(t => t.status === 'open');
  if (excludeUserId) tasks = tasks.filter(t => t.posted_by !== excludeUserId);
  return tasks.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function createTask({ title, description, offering, wanting, type, duration, schedule, posted_by, userName, userAvatar, ai_metadata }) {
  const db = readDb();
  const task = {
    id: uuidv4(),
    title, description,
    offering: offering || [],
    wanting: wanting || [],
    type: type || 'direct',
    duration: duration || '1 hour',
    schedule: schedule || 'Anytime',
    status: 'open',
    posted_by,
    user: { name: userName || 'User', avatar_url: userAvatar || null },
    ai_metadata: ai_metadata || null,
    created_at: new Date().toISOString()
  };
  db.tasks.unshift(task);
  writeDb(db);
  return task;
}

function getTaskById(taskId) {
  const db = readDb();
  return db.tasks.find(t => t.id === taskId) || null;
}

function updateTaskStatus(taskId, status) {
  const db = readDb();
  const task = db.tasks.find(t => t.id === taskId);
  if (task) { task.status = status; writeDb(db); }
  return task;
}

// ─── Requests ─────────────────────────────────────────────────────────────────
function createRequest({ task_id, requested_by, message, requesterName, requesterAvatar, target_user_id, task_title, task_offering, task_wanting, owner_name, owner_avatar }) {
  const db = readDb();
  let task = db.tasks.find(t => t.id === task_id);
  const request = {
    id: uuidv4(),
    task_id: task_id || null,
    target_user_id: target_user_id || (task ? task.posted_by : null),
    requested_by,
    message: message || '',
    status: 'pending',
    requester: { name: requesterName || 'User', avatar_url: requesterAvatar || null },
    owner: { name: owner_name || 'Mentor', avatar_url: owner_avatar || null },
    task: task ? { ...task } : {
      id: task_id,
      title: task_title || "Direct Connection",
      posted_by: target_user_id,
      offering: task_offering || "",
      wanting: task_wanting || ""
    },
    created_at: new Date().toISOString()
  };
  db.requests.unshift(request);
  writeDb(db);
  return request;
}

function getRequestById(requestId) {
  const db = readDb();
  return db.requests.find(r => r.id === requestId) || null;
}

function updateRequestStatus(requestId, status) {
  const db = readDb();
  const req = db.requests.find(r => r.id === requestId);
  if (!req) return null;

  req.status = status;

  let room = null;
  if (status === 'accepted') {
    const task = req.task_id ? db.tasks.find(t => t.id === req.task_id) : null;
    if (task) task.status = 'matched';

    room = createChatRoom({
      taskId: req.task_id,
      requestId: req.id,
      poster: req.target_user_id || (task ? task.posted_by : null),
      posterName: (task ? task.user?.name : 'Partner') || 'User',
      posterAvatar: (task ? task.user?.avatar_url : null) || null,
      requester: req.requested_by,
      requesterName: req.requester?.name || 'User',
      requesterAvatar: req.requester?.avatar_url || null,
      taskTitle: task ? task.title : (req.task?.title || "Peer Exchange"),
      taskWanting: task ? task.wanting : []
    });
    room.status = 'active';
  }

  writeDb(db);
  return { request: req, room };
}

function getBroadcastRequests(broadcastId) {
  const db = readDb();
  return (db.broadcast_requests || []).filter(r => r.broadcast_id === broadcastId);
}

function declineOtherRequests(taskId, acceptedRequestId) {
  const db = readDb();
  db.requests.forEach(r => {
    if (r.task_id === taskId && r.id !== acceptedRequestId && r.status === 'pending') r.status = 'declined';
  });
  writeDb(db);
}

// ─── Chat Rooms ───────────────────────────────────────────────────────────────
function createChatRoom({ taskId, requestId, poster, posterName, posterAvatar, requester, requesterName, requesterAvatar, taskTitle, taskWanting }) {
  const db = readDb();
  const existing = db.rooms.find(r => r.request_id === requestId);
  if (existing) return existing;

  const room = {
    id: uuidv4(),
    task_id: taskId,
    request_id: requestId,
    poster: poster,
    task_title: taskTitle || 'Skill Exchange',
    task_wanting: taskWanting || [],
    participants: [poster, requester],
    participant_info: {
      [poster]: { name: posterName, avatar_url: posterAvatar || null },
      [requester]: { name: requesterName, avatar_url: requesterAvatar || null }
    },
    status: 'pending',
    connected: false,
    connection_clicks: [],
    messages: [],
    created_at: new Date().toISOString(),
    last_message: null
  };
  db.rooms.push(room);
  writeDb(db);
  return room;
}

function syncSupabaseRoom({ id, task_id, user_a, user_b, partner_name, partner_avatar }) {
  if (!id) throw new Error('id is required');
  if (!user_a || !user_b) throw new Error('user_a and user_b are required');
  const db = readDb();
  let room = db.rooms.find(r => r.id === id);
  if (!room && task_id) {
    room = db.rooms.find(r =>
      r.task_id === task_id &&
      r.participants?.includes(user_a) &&
      r.participants?.includes(user_b)
    );
  }
  if (room) return room;

  room = {
    id: id,
    task_id: task_id,
    participants: [user_a, user_b],
    participant_info: {
      [user_a]: { name: "User", avatar_url: null },
      [user_b]: { name: partner_name || "Partner", avatar_url: partner_avatar || null }
    },
    status: 'active',
    connected: false,
    connection_clicks: [],
    messages: [],
    created_at: new Date().toISOString(),
    last_message: null
  };
  db.rooms.push(room);
  writeDb(db);
  return room;
}

function getRoomById(roomId) {
  const db = readDb();
  return db.rooms.find(r => r.id === roomId) || null;
}

function getUserRooms(userId) {
  const db = readDb();
  return db.rooms
    .filter(r => r.participants.includes(userId))
    .sort((a, b) => {
      const aTime = a.last_message?.created_at || a.created_at;
      const bTime = b.last_message?.created_at || b.created_at;
      return new Date(bTime) - new Date(aTime);
    });
}

function addMessage(roomId, { senderId, senderName, content }) {
  const db = readDb();
  const room = db.rooms.find(r => r.id === roomId);
  if (!room) return null;
  const msg = {
    id: uuidv4(),
    room_id: roomId,
    sender_id: senderId,
    sender_name: senderName,
    content,
    created_at: new Date().toISOString()
  };
  room.messages.push(msg);
  room.last_message = { content, sender_name: senderName, created_at: msg.created_at };
  writeDb(db);
  return msg;
}

function setRoomWorkDone(roomId, userId) {
  const db = readDb();
  const room = db.rooms.find(r => r.id === roomId);
  if (room) {
    if (!room.work_done_by) room.work_done_by = [];
    if (!room.work_done_by.includes(userId)) room.work_done_by.push(userId);
    writeDb(db);
  }
  return room;
}

function activateRoom(roomId) {
  const db = readDb();
  const room = db.rooms.find(r => r.id === roomId);
  if (room) { room.status = 'active'; writeDb(db); }
  return room;
}

function setRoomConnected(roomId, userId) {
  const db = readDb();
  const room = db.rooms.find(r => r.id === roomId);
  if (room) {
    if (!room.connection_clicks) room.connection_clicks = [];
    if (!room.connection_clicks.includes(userId)) room.connection_clicks.push(userId);
    if (room.connection_clicks.length >= 2) {
      room.connected = true;
      room.status = 'exchanged';
      if (room.task_id) {
        const task = db.tasks.find(t => t.id === room.task_id);
        if (task) task.status = 'completed';
      }
    }
    writeDb(db);
  }
  return room;
}

// ─── Notifications ────────────────────────────────────────────────────────────
function addNotification({ user_id, content, type, reference_id, task_id }) {
  const db = readDb();
  const note = {
    id: uuidv4(),
    user_id, content, type,
    reference_id: reference_id || null,
    task_id: task_id || null,
    is_read: false,
    created_at: new Date().toISOString()
  };
  db.notifications.unshift(note);
  writeDb(db);
  return note;
}

function getNotifications(userId) {
  const db = readDb();
  return (db.notifications || []).filter(n => n.user_id === userId);
}

function deleteNotification(id) {
  const db = readDb();
  db.notifications = db.notifications.filter(n => n.id !== id);
  writeDb(db);
}

function clearNotificationByReference(referenceId) {
  const db = readDb();
  db.notifications = db.notifications.filter(n => n.reference_id !== referenceId);
  writeDb(db);
}

function markNotificationRead(id) {
  const db = readDb();
  const n = db.notifications.find(n => n.id === id);
  if (n) { n.is_read = true; writeDb(db); }
}

// ─── Ratings ─────────────────────────────────────────────────────────────────
function addRating({ rated_user_id, rater_id, rater_name, rater_avatar, stars, comment, credits, task_title }) {
  const db = readDb();
  const existing = db.ratings.find(r => r.rated_user_id === rated_user_id && r.rater_id === rater_id && r.task_title === task_title);
  if (existing) {
    existing.stars = stars;
    existing.comment = comment;
    existing.credits = credits || 0;
    existing.updated_at = new Date().toISOString();
    writeDb(db);
    return existing;
  }
  const rating = {
    id: uuidv4(),
    rated_user_id, rater_id,
    rater_name: rater_name || 'User',
    rater_avatar: rater_avatar || null,
    stars,
    credits: credits || 0,
    comment: comment || '',
    task_title: task_title || 'Skill Exchange',
    created_at: new Date().toISOString()
  };
  db.ratings.unshift(rating);
  writeDb(db);
  return rating;
}

function getRatingsForUser(userId) {
  const db = readDb();
  const ratings = (db.ratings || []).filter(r => r.rated_user_id === userId);
  const count = ratings.length;
  const avg = count > 0 ? ratings.reduce((sum, r) => sum + r.stars, 0) / count : 0;
  const totalCredits = ratings.reduce((sum, r) => sum + (r.credits || 0), 0);
  const breakdown = [5, 4, 3, 2, 1].map(star => ({
    star,
    count: ratings.filter(r => r.stars === star).length
  }));
  return { ratings, avg: Math.round(avg * 10) / 10, count, breakdown, totalCredits };
}

// ─── Broadcasts ───────────────────────────────────────────────────────────────
function getUserPosts(userId) {
  const db = readDb();
  const tasks = (db.tasks || []).filter(t => t.posted_by === userId).map(t => {
    const reqs = (db.requests || []).filter(r => r.task_id === t.id);
    return {
      ...t,
      post_type: 'direct',
      stats: {
        pending: reqs.filter(r => r.status === 'pending').length,
        accepted: reqs.filter(r => r.status === 'accepted').length,
        declined: reqs.filter(r => r.status === 'declined').length,
      }
    };
  });

  const broadcasts = (db.broadcasts || []).filter(b => b.posted_by === userId).map(b => {
    const enrollments = (db.broadcast_enrollments || []).filter(e => e.broadcast_id === b.id);
    return {
      ...b,
      post_type: 'broadcast',
      enrollments_count: enrollments.length,
      stats: {
        enrolled: enrollments.filter(e => e.status === 'enrolled').length,
        attended: enrollments.filter(e => e.status === 'attended').length,
        no_show: enrollments.filter(e => e.status === 'no_show').length,
      }
    };
  });

  return [...tasks, ...broadcasts].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function getAllBroadcasts({ query, userId, includeAll } = {}) {
  const db = readDb();
  let broadcasts = db.broadcasts || [];

  // For public discovery, only show published and live classes
  if (!includeAll) {
    broadcasts = broadcasts.filter(b => b.status === 'published' || b.status === 'live');
  }

  if (query) {
    const q = query.toLowerCase();
    broadcasts = broadcasts.filter(b =>
      b.title.toLowerCase().includes(q) ||
      b.description.toLowerCase().includes(q)
    );
  }

  if (userId) {
    broadcasts = broadcasts.map(b => {
      const enrollment = (db.broadcast_enrollments || []).find(e => e.broadcast_id === b.id && e.user_id === userId);
      return {
        ...b,
        my_enrollment: enrollment?.status || null,
      };
    });
  }

  return broadcasts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function getTutorBroadcasts(userId) {
  const db = readDb();
  const broadcasts = (db.broadcasts || []).filter(b => b.posted_by === userId);
  return broadcasts.map(b => {
    const enrollments = (db.broadcast_enrollments || []).filter(e => e.broadcast_id === b.id);
    return { ...b, enrollments_count: enrollments.length };
  }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function createBroadcast({ title, description, duration, deadline, max_people, reward_credits, category, scheduled_at, difficulty, prerequisites, status, posted_by, userName, userAvatar }) {
  const db = readDb();
  const broadcast = {
    id: uuidv4(),
    title,
    description,
    duration,
    deadline,
    max_people: parseInt(max_people) || 10,
    current_people: 0,
    reward_credits: parseInt(reward_credits) || 0,
    category: category || 'General',
    scheduled_at: scheduled_at || null,
    difficulty: difficulty || 'beginner',
    prerequisites: prerequisites || '',
    status: status || 'draft',
    posted_by,
    user: { name: userName || 'User', avatar_url: userAvatar || null },
    created_at: new Date().toISOString()
  };
  db.broadcasts.unshift(broadcast);
  writeDb(db);
  return broadcast;
}

function getBroadcastById(id) {
  const db = readDb();
  return db.broadcasts.find(b => b.id === id) || null;
}

function publishBroadcast(id) {
  const db = readDb();
  const b = db.broadcasts.find(b => b.id === id);
  if (!b) return null;
  b.status = 'published';
  writeDb(db);
  return b;
}

function enrollInBroadcast({ broadcast_id, user_id, userName, userAvatar }) {
  const db = readDb();
  const broadcast = db.broadcasts.find(b => b.id === broadcast_id);
  if (!broadcast) return { error: 'Broadcast not found' };

  // Credit check
  const learner = db.users.find(u => u.id === user_id);
  const balance = learner ? (learner.points ?? 200) : 200;
  if (broadcast.reward_credits > 0 && balance < broadcast.reward_credits) {
    return { error: 'Insufficient credits to join this class' };
  }


  if (!db.broadcast_enrollments) db.broadcast_enrollments = [];
  const existing = db.broadcast_enrollments.find(e => e.broadcast_id === broadcast_id && e.user_id === user_id);
  if (existing) return existing;

  const enrollment = {
    id: uuidv4(),
    broadcast_id,
    user_id,
    status: 'enrolled',
    user: { name: userName || 'User', avatar_url: userAvatar || null },
    enrolled_at: new Date().toISOString()
  };

  // Deduct credits from learner
  if (broadcast.reward_credits > 0) {
    if (!db.users) db.users = [];
    let learnerRecord = db.users.find(u => u.id === user_id);
    if (!learnerRecord) {
      learnerRecord = { id: user_id, points: 200 };
      db.users.push(learnerRecord);
    }
    learnerRecord.points = (learnerRecord.points ?? 200) - broadcast.reward_credits;

    if (!db.credit_transactions) db.credit_transactions = [];
    db.credit_transactions.push({
      id: uuidv4(),
      broadcast_id,
      user_id,
      amount: -broadcast.reward_credits,
      type: 'debit',
      reason: `Enrollment in class: ${broadcast.title}`,
      created_at: new Date().toISOString()
    });
  }

  db.broadcast_enrollments.push(enrollment);
  broadcast.current_people = (broadcast.current_people || 0) + 1;
  writeDb(db);
  return enrollment;
}

function getEnrollments(broadcastId) {
  const db = readDb();
  return (db.broadcast_enrollments || []).filter(e => e.broadcast_id === broadcastId);
}

function startBroadcast(id) {
  const db = readDb();
  const b = db.broadcasts.find(b => b.id === id);
  if (!b) return null;
  b.status = 'live';
  b.started_at = new Date().toISOString();
  writeDb(db);
  return b;
}

function getBroadcastChatRoom(broadcastId) {
  const dbData = readDb();
  if (!dbData.broadcast_rooms) dbData.broadcast_rooms = [];
  let room = dbData.broadcast_rooms.find(r => r.broadcast_id === broadcastId);
  if (!room) {
    // Auto-create the room; use broadcast title if available, generic fallback otherwise
    const broadcast = (dbData.broadcasts || []).find(b => b.id === broadcastId);
    room = {
      id: uuidv4(),
      broadcast_id: broadcastId,
      title: broadcast ? broadcast.title : 'Broadcast Class',
      notes: '',
      messages: [],
      created_at: new Date().toISOString()
    };
    dbData.broadcast_rooms.push(room);
    writeDb(dbData);
  }
  return room;
}

function addBroadcastChatMessage(broadcastId, { senderId, senderName, content }) {
  const dbData = readDb();
  if (!dbData.broadcast_rooms) dbData.broadcast_rooms = [];
  let room = dbData.broadcast_rooms.find(r => r.broadcast_id === broadcastId);
  if (!room) {
    // Auto-create room if it doesn't exist yet (race between socket and HTTP)
    const broadcast = (dbData.broadcasts || []).find(b => b.id === broadcastId);
    room = {
      id: uuidv4(),
      broadcast_id: broadcastId,
      title: broadcast ? broadcast.title : 'Broadcast Class',
      notes: '',
      messages: [],
      created_at: new Date().toISOString()
    };
    dbData.broadcast_rooms.push(room);
  }
  const message = {
    id: uuidv4(),
    broadcast_id: broadcastId,
    sender_id: senderId,
    sender_name: senderName,
    content,
    created_at: new Date().toISOString()
  };
  if (!room.messages) room.messages = [];
  room.messages.push(message);
  room.last_message = { content, sender_name: senderName, created_at: message.created_at };
  writeDb(dbData);
  return message;
}

function saveBroadcastChatNotes(broadcastId, notes) {
  const dbData = readDb();
  if (!dbData.broadcast_rooms) dbData.broadcast_rooms = [];
  let room = dbData.broadcast_rooms.find(r => r.broadcast_id === broadcastId);
  if (!room) {
    const broadcast = (dbData.broadcasts || []).find(b => b.id === broadcastId);
    room = {
      id: uuidv4(),
      broadcast_id: broadcastId,
      title: broadcast ? broadcast.title : 'Broadcast Class',
      notes: '',
      messages: [],
      created_at: new Date().toISOString()
    };
    dbData.broadcast_rooms.push(room);
  }
  room.notes = notes;
  writeDb(dbData);
  return room;
}

function getBroadcastParticipants(broadcastId) {
  const dbData = readDb();
  const broadcast = (dbData.broadcasts || []).find(b => b.id === broadcastId);
  if (!broadcast) return [];
  const participants = [{ user_id: broadcast.posted_by, user: broadcast.user, status: 'tutor', is_tutor: true }];
  (dbData.broadcast_enrollments || [])
    .filter(e => e.broadcast_id === broadcastId && e.user_id !== broadcast.posted_by)
    .forEach(e => participants.push({ user_id: e.user_id, user: e.user, status: e.status, is_tutor: false }));
  return participants;
}

function autoUpdateBroadcastStatuses() {
  const dbData = readDb();
  const now = new Date();
  let changed = false;
  (dbData.broadcasts || []).forEach(b => {
    if (b.status === 'published' && b.scheduled_at && new Date(b.scheduled_at) <= now) {
      b.status = 'live';
      b.started_at = b.scheduled_at;
      changed = true;
    }
  });
  if (changed) writeDb(dbData);
}

function getUserBalance(userId) {
  const dbData = readDb();
  const user = (dbData.users || []).find(u => u.id === userId);
  return user ? (user.points ?? 200) : 200;
}

function getUserEnrollments(userId) {
  const dbData = readDb();
  const enrollments = (dbData.broadcast_enrollments || []).filter(e => e.user_id === userId);
  return enrollments.map(e => {
    const broadcast = (dbData.broadcasts || []).find(b => b.id === e.broadcast_id);
    if (!broadcast) return null;
    return { ...e, broadcast };
  }).filter(Boolean).sort((a, b) => new Date(b.enrolled_at) - new Date(a.enrolled_at));
}

function cancelBroadcast(id) {
  const dbData = readDb();
  const b = (dbData.broadcasts || []).find(b => b.id === id);
  if (!b || b.status === 'completed' || b.status === 'cancelled') return null;
  b.status = 'cancelled';
  b.cancelled_at = new Date().toISOString();
  writeDb(dbData);
  return b;
}

function endBroadcast(id, attendances) {
  const db = readDb();
  const broadcast = db.broadcasts.find(b => b.id === id);
  if (!broadcast) return null;

  broadcast.status = 'completed';
  broadcast.ended_at = new Date().toISOString();

  if (!db.credit_transactions) db.credit_transactions = [];

  let attendedCount = 0;
  let totalCreditsForTutor = 0;
  
  (attendances || []).forEach(a => {
    const enrollment = (db.broadcast_enrollments || []).find(e => e.broadcast_id === id && e.user_id === a.user_id);
    if (enrollment) {
      enrollment.status = a.attended ? 'attended' : 'no_show';
      if (a.attended) {
        attendedCount++;
        totalCreditsForTutor += (broadcast.reward_credits || 0);
      }
    }
  });

  // Pay the tutor
  if (totalCreditsForTutor > 0) {
    if (!db.users) db.users = [];
    let tutorRecord = db.users.find(u => u.id === broadcast.posted_by);
    if (!tutorRecord) {
      tutorRecord = { id: broadcast.posted_by, points: 200 };
      db.users.push(tutorRecord);
    }
    tutorRecord.points = (tutorRecord.points ?? 200) + totalCreditsForTutor;

    db.credit_transactions.push({
      id: uuidv4(),
      broadcast_id: id,
      user_id: broadcast.posted_by,
      amount: totalCreditsForTutor,
      type: 'credit',
      reason: `Earnings from completed class: ${broadcast.title} (${attendedCount} attendees)`,
      created_at: new Date().toISOString()
    });
  }

  writeDb(db);
  return { ...broadcast, attendedCount, totalAwarded: totalCreditsForTutor };
}

// Removed legacy broadcast_requests functions

function getUserRequests(userId) {
  const db = readDb();

  const incoming = (db.requests || []).filter(r => r.target_user_id === userId || r.task?.posted_by === userId).map(r => {
    const task = r.task_id ? db.tasks.find(t => t.id === r.task_id) : r.task;
    const room = db.rooms.find(rm => rm.request_id === r.id);
    return {
      ...r,
      room_id: room?.id || null,
      type: r.type || 'direct',
      tasks: task || r.task,
      owner: { name: 'Me', avatar_url: null }
    };
  });

  const outgoing = (db.requests || []).filter(r => r.requested_by === userId).map(r => {
    const task = r.task_id ? db.tasks.find(t => t.id === r.task_id) : r.task;
    const room = db.rooms.find(rm => rm.request_id === r.id);
    return {
      ...r,
      room_id: room?.id || null,
      type: r.type || 'direct',
      tasks: task || r.task,
      owner: r.owner || (task?.user ? { name: task.user.name, avatar_url: task.user.avatar_url } : { name: 'Mentor', avatar_url: null })
    };
  });

  const incomingBroadcast = (db.broadcast_requests || []).filter(r => {
    const b = db.broadcasts.find(b => b.id === r.broadcast_id);
    return b && b.posted_by === userId;
  }).map(r => ({ ...r, type: 'broadcast', task_id: r.broadcast_id, tasks: { title: r.broadcast_title }, owner: { name: 'Me' } }));

  const outgoingBroadcast = (db.broadcast_requests || []).filter(r => r.requested_by === userId).map(r => {
    const b = db.broadcasts.find(b => b.id === r.broadcast_id);
    return {
      ...r,
      type: 'broadcast',
      task_id: r.broadcast_id,
      tasks: { title: r.broadcast_title },
      owner: b ? { name: b.user?.name, avatar_url: b.user?.avatar_url } : { name: 'Tutor' }
    };
  });

  const matchIncoming = (db.match_requests || []).filter(r => r.to_user_id === userId).map(r => ({
    ...r,
    type: 'match',
    tasks: { title: `${r.giving_skills.join(', ')} ⇄ ${r.receiving_skills.join(', ')}` },
    owner: { name: 'Me' }
  }));

  const matchOutgoing = (db.match_requests || []).filter(r => r.from_user_id === userId).map(r => ({
    ...r,
    type: 'match',
    tasks: { title: `${r.giving_skills.join(', ')} ⇄ ${r.receiving_skills.join(', ')}` },
    owner: { name: r.to_name, avatar_url: r.to_avatar }
  }));

  return {
    incoming: [...incoming, ...incomingBroadcast, ...matchIncoming].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    outgoing: [...outgoing, ...outgoingBroadcast, ...matchOutgoing].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  };
}

// ─── Connection Stages & Handshakes ──────────────────────────────────────────
function confirmStage(roomId, userId, stage, delivery_note = null) {
  const db = readDb();

  const existing = db.connection_stages.find(s => s.room_id === roomId && s.user_id === userId && s.stage === stage);
  if (existing) return { advanced: false, already_confirmed: true };

  const confirmation = {
    id: uuidv4(),
    room_id: roomId,
    user_id: userId,
    stage,
    delivery_note,
    confirmed_at: new Date().toISOString()
  };
  db.connection_stages.push(confirmation);

  const room = db.rooms.find(r => r.id === roomId);
  if (!room) return { advanced: false };

  const stageConfirmations = db.connection_stages.filter(s => s.room_id === roomId && s.stage === stage);
  const confirmedUserIds = stageConfirmations.map(s => s.user_id);
  const allParticipantsConfirmed = room.participants.every(pId => confirmedUserIds.includes(pId));

  if (allParticipantsConfirmed) {
    if (stage === 'work_done') {
      room.status = 'review';
      addMessage(roomId, { senderId: 'system', senderName: 'System', content: "Both users have marked the work as done. Please leave a review for your peer." });
    } else if (stage === 'connected') {
      room.status = 'in_progress';
      addMessage(roomId, { senderId: 'system', senderName: 'System', content: "Both users have connected. The exchange has officially started. 🤝" });
    }
  }

  writeDb(db);
  return { advanced: allParticipantsConfirmed, confirmation };
}

function getRoomStatus(roomId) {
  const db = readDb();
  const room = db.rooms.find(r => r.id === roomId);
  const stages = db.connection_stages.filter(s => s.room_id === roomId);
  const reviews = db.reviews.filter(r => r.room_id === roomId);
  const dispute = db.disputes.find(d => d.room_id === roomId);
  return { room, stages, reviews, dispute };
}

// ─── Reviews & Disputes ───────────────────────────────────────────────────────
function saveReview(reviewData) {
  const db = readDb();

  if (!reviewData.target_user_id && reviewData.room_id) {
    const room = db.rooms.find(r => r.id === reviewData.room_id);
    if (room) {
      const participants = room.participants || [room.user_a, room.user_b].filter(Boolean);
      reviewData.target_user_id = participants.find(p => p !== reviewData.reviewer_id);
    }
  }

  const review = {
    id: uuidv4(),
    ...reviewData,
    created_at: new Date().toISOString()
  };
  db.reviews.push(review);

  const room = db.rooms.find(r => r.id === reviewData.room_id);
  let complete = false;

  if (room) {
    const participants = room.participants || [room.user_a, room.user_b].filter(Boolean);
    const roomReviews = db.reviews.filter(r => r.room_id === reviewData.room_id);

    if (roomReviews.length >= participants.length) {
      room.status = 'completed';
      complete = true;

      if (!db.reviews.find(r => r.room_id === reviewData.room_id && r._completion_msg)) {
        db.rooms.find(r => r.id === reviewData.room_id)?.messages?.push({
          id: uuidv4(),
          room_id: reviewData.room_id,
          sender_id: 'system',
          sender_name: 'System',
          content: '🎉 Exchange complete! Both users have submitted their reviews.',
          created_at: new Date().toISOString()
        });
      }

      participants.forEach(pid => {
        let userProfile = db.users.find(u => u.id === pid);
        if (!userProfile) {
          userProfile = { id: pid, reviews_count: 0, rating: 0, analysis: '', enhancements: [], points: 200, completed_count: 0 };
          db.users.push(userProfile);
        }
        userProfile.points = (userProfile.points || 0) + 50;
        userProfile.completed_count = (userProfile.completed_count || 0) + 1;
      });

      if (room.task_id) {
        const task = db.tasks.find(t => t.id === room.task_id);
        if (task) task.status = 'completed';
      }
    }

    const targetId = reviewData.target_user_id || reviewData.reviewed_id;
    if (targetId) {
      const targetReviews = db.reviews.filter(r =>
        r.target_user_id === targetId || r.reviewed_id === targetId
      );
      const avgRating = targetReviews.reduce((sum, r) => sum + (r.rating || 0), 0) / targetReviews.length;

      let userProfile = db.users.find(u => u.id === targetId);
      if (!userProfile) {
        userProfile = { id: targetId, reviews_count: 0, rating: 0, analysis: '', enhancements: [] };
        db.users.push(userProfile);
      }
      userProfile.reviews_count = targetReviews.length;
      userProfile.rating = parseFloat(avgRating.toFixed(1));
      userProfile.analysis = `${targetReviews.length} review${targetReviews.length > 1 ? 's' : ''} · Avg rating ${userProfile.rating}. Latest: "${reviewData.comment}"`;
    }
  }

  writeDb(db);
  return { review, complete };
}

function saveDispute(disputeData) {
  const db = readDb();
  const dispute = {
    id: uuidv4(),
    ...disputeData,
    status: 'open',
    created_at: new Date().toISOString()
  };
  db.disputes.push(dispute);
  const room = db.rooms.find(r => r.id === disputeData.room_id);
  if (room) room.status = 'disputed';
  writeDb(db);
  return dispute;
}

function addNote(userId, noteData) {
  const db = readDb();
  let user = db.users.find(u => u.id === userId);
  if (!user) {
    user = { id: userId, reviews_count: 0, rating: 0, analysis: {}, enhancements: [], points: 200, uploads: [] };
    db.users.push(user);
  }
  if (!user.uploads) user.uploads = [];
  const newNote = { id: uuidv4(), ...noteData, created_at: new Date().toISOString() };
  user.uploads.push(newNote);
  writeDb(db);
  return newNote;
}

// ─── User Skills ─────────────────────────────────────────────────────────────
function addUserSkill(userId, { skill_name, skill_type }) {
  const db = readDb();
  const skill = {
    id: uuidv4(),
    user_id: userId,
    skill_name,
    skill_type,
    created_at: new Date().toISOString()
  };
  db.user_skills.push(skill);
  writeDb(db);
  return skill;
}

function removeUserSkill(skillId) {
  const db = readDb();
  db.user_skills = db.user_skills.filter(s => s.id !== skillId);
  writeDb(db);
  return true;
}

function getUserSkills(userId) {
  const db = readDb();
  return db.user_skills.filter(s => s.user_id === userId);
}

// ─── Bidirectional Matching ──────────────────────────────────────────────────
function getAllSkillProfiles() {
  const db = readDb();
  const userMap = new Map();

  (db.tasks || []).forEach(t => {
    if (t.type !== 'direct' || t.status !== 'open') return;
    if (!userMap.has(t.posted_by)) {
      const user = (db.users || []).find(u => u.id === t.posted_by);
      userMap.set(t.posted_by, {
        id: t.posted_by,
        name: user?.name || t.user?.name || "Unknown User",
        avatar_url: user?.profilePic || t.user?.avatar_url || null,
        offering_skills: new Set(),
        wanting_skills: new Set(),
        avg_rating: user?.rating || 0,
        sessions_completed: user?.reviews_count || 0,
        is_available: true
      });
    }
    const profile = userMap.get(t.posted_by);
    if (Array.isArray(t.offering)) t.offering.forEach(s => profile.offering_skills.add(s));
    else if (t.offering) profile.offering_skills.add(t.offering);
    if (Array.isArray(t.wanting)) t.wanting.forEach(s => profile.wanting_skills.add(s));
    else if (t.wanting) profile.wanting_skills.add(t.wanting);
  });

  return Array.from(userMap.values()).map(p => ({
    ...p,
    offering_skills: Array.from(p.offering_skills),
    wanting_skills: Array.from(p.wanting_skills)
  }));
}

function findBidirectionalMatches(userId) {
  try {
    const allProfiles = getAllSkillProfiles();
    const db = readDb();
    let currentUser = allProfiles.find(p => p.id === userId);

    if (!currentUser) {
      const dbUser = db.users.find(u => u.id === userId);
      const userSkills = db.user_skills.filter(s => s.user_id === userId);
      if (userSkills.length > 0 || dbUser) {
        currentUser = {
          id: userId,
          name: dbUser?.name || "You",
          avatar_url: dbUser?.avatar_url || null,
          offering_skills: userSkills.filter(s => s.skill_type === 'offering').map(s => s.skill_name),
          wanting_skills: userSkills.filter(s => s.skill_type === 'wanting').map(s => s.skill_name),
          avg_rating: dbUser?.rating || 0,
          sessions_completed: dbUser?.completed_count || 0
        };
      }
    }

    if (!currentUser || (!currentUser.offering_skills?.length && !currentUser.wanting_skills?.length)) {
      return { currentUser: currentUser || null, matches: [] };
    }
    const tasks = db.tasks || [];

    const matches = allProfiles
      .filter(peer => peer.id !== userId)
      .reduce((results, peer) => {
        if (!peer.offering_skills?.length || !peer.wanting_skills?.length) return results;

        const theyOfferWhatINeed = currentUser.wanting_skills.filter(skill =>
          skill && peer.offering_skills.some(s => s && s.trim().toLowerCase() === skill.trim().toLowerCase())
        );
        const iOfferWhatTheyNeed = peer.wanting_skills.filter(skill =>
          skill && currentUser.offering_skills.some(s => s && s.trim().toLowerCase() === skill.trim().toLowerCase())
        );

        if (!theyOfferWhatINeed.length || !iOfferWhatTheyNeed.length) return results;

        const bestTask = tasks.find(t =>
          t.posted_by === peer.id &&
          (Array.isArray(t.offering) ? t.offering : [t.offering]).some(s =>
            theyOfferWhatINeed.some(need => need.toLowerCase() === (s || "").toLowerCase())
          )
        );

        const offerCoverage = theyOfferWhatINeed.length / currentUser.wanting_skills.length;
        const needCoverage = iOfferWhatTheyNeed.length / peer.wanting_skills.length;
        const matchScore = Math.round((offerCoverage * 50) + (needCoverage * 50));

        results.push({ peer, task: bestTask || null, theyOfferWhatINeed, iOfferWhatTheyNeed, matchScore });
        return results;
      }, [])
      .sort((a, b) => b.matchScore - a.matchScore);

    return { currentUser, matches };
  } catch (err) {
    console.error("findBidirectionalMatches crash:", err);
    return { currentUser: null, matches: [] };
  }
}

// ─── Match Requests ─────────────────────────────────────────────────────────
function createMatchRequest({ from_user_id, to_user_id, giving_skills, receiving_skills, message, from_name, from_avatar, to_name, to_avatar }) {
  const db = readDb();
  const existing = db.match_requests.find(r =>
    r.from_user_id === from_user_id && r.to_user_id === to_user_id && r.status === 'pending'
  );
  if (existing) return existing;

  const request = {
    id: uuidv4(),
    from_user_id,
    to_user_id,
    giving_skills: giving_skills || [],
    receiving_skills: receiving_skills || [],
    message: message || '',
    status: 'pending',
    from_name: from_name || 'User',
    from_avatar: from_avatar || null,
    to_name: to_name || 'User',
    to_avatar: to_avatar || null,
    created_at: new Date().toISOString()
  };
  db.match_requests.unshift(request);
  writeDb(db);
  return request;
}

function updateMatchRequestStatus(requestId, status) {
  const db = readDb();
  const req = db.match_requests.find(r => r.id === requestId);
  if (!req) return { request: null, room: null };

  req.status = status;
  let room = null;

  if (status === 'accepted') {
    const reverse = db.match_requests.find(r =>
      r.from_user_id === req.to_user_id && r.to_user_id === req.from_user_id && r.status === 'pending'
    );
    if (reverse) reverse.status = 'accepted';

    room = {
      id: uuidv4(),
      task_id: null,
      request_id: req.id,
      match_type: 'direct_swap',
      task_title: `${req.giving_skills.join(', ')} ⇄ ${req.receiving_skills.join(', ')}`,
      task_wanting: req.receiving_skills,
      participants: [req.from_user_id, req.to_user_id],
      participant_info: {
        [req.from_user_id]: { name: req.from_name, avatar_url: req.from_avatar },
        [req.to_user_id]: { name: req.to_name, avatar_url: req.to_avatar }
      },
      status: 'active',
      connected: false,
      connection_clicks: [],
      messages: [],
      created_at: new Date().toISOString(),
      last_message: null
    };
    db.rooms.push(room);
  }

  writeDb(db);
  return { request: req, room };
}

function getMatchRequestsForUser(userId) {
  const db = readDb();
  return (db.match_requests || []).filter(r => r.from_user_id === userId || r.to_user_id === userId);
}

function getMatchRequestBetween(userA, userB) {
  const db = readDb();
  return (db.match_requests || []).find(r =>
    (r.from_user_id === userA && r.to_user_id === userB) ||
    (r.from_user_id === userB && r.to_user_id === userA)
  ) || null;
}

function updateUserProfile(userId, profileData) {
  const db = readDb();
  let user = db.users.find(u => u.id === userId);
  if (!user) {
    user = { id: userId, reviews_count: 0, rating: 0, analysis: {}, points: 200 };
    db.users.push(user);
  }
  Object.assign(user, profileData);
  writeDb(db);
  return user;
}

// ─── Moderation Actions ───────────────────────────────────────────────────────
function addModerationAction({ report_id, admin_id, admin_email, target_user_id, action_type, duration_days, admin_note }) {
  const db = readDb();
  if (!db.moderation_actions) db.moderation_actions = [];
  const action = {
    id: uuidv4(),
    report_id,
    admin_id: admin_id || null,
    admin_email: admin_email || 'admin',
    target_user_id,
    action_type,
    duration_days: duration_days || null,
    admin_note,
    created_at: new Date().toISOString(),
  };
  db.moderation_actions.push(action);
  writeDb(db);
  return action;
}

function getModerationActionsForReport(reportId) {
  const db = readDb();
  return (db.moderation_actions || [])
    .filter(a => a.report_id === reportId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

// ─── Admin Management ─────────────────────────────────────────────────────────
function getAdminByEmail(email) {
  const db = readDb();
  return db.admins?.find(a => a.email?.toLowerCase() === email?.toLowerCase()) || null;
}

function getAllAdmins() {
  const db = readDb();
  return db.admins || [];
}

function addAdmin({ email, name, role = 'moderator' }) {
  const db = readDb();
  if (!db.admins) db.admins = [];
  if (db.admins.find(a => a.email?.toLowerCase() === email?.toLowerCase())) {
    throw new Error('Admin with this email already exists');
  }
  const admin = { id: uuidv4(), email, name, role, created_at: new Date().toISOString() };
  db.admins.push(admin);
  writeDb(db);
  return admin;
}

function removeAdmin(email) {
  const db = readDb();
  const before = db.admins?.length || 0;
  db.admins = (db.admins || []).filter(a => a.email?.toLowerCase() !== email?.toLowerCase());
  writeDb(db);
  return before !== db.admins.length;
}

// ─── Project Composite ────────────────────────────────────────────────────────
function createProject({ title, description, roles, min_team_size, total_credits, deadline, owner_id, owner_name, owner_avatar }) {
  const db = readDb();
  let owner = db.users.find(u => u.id === owner_id);
  if (!owner) {
    owner = { id: owner_id, reviews_count: 0, rating: 0, analysis: {}, points: 200, completed_count: 0 };
    db.users.push(owner);
  }
  if ((owner.points || 0) < total_credits) throw new Error('Insufficient credits to post this project');
  owner.points = (owner.points || 0) - total_credits;

  const project = {
    id: uuidv4(),
    title, description,
    roles: (roles || []).map(r => ({ ...r, id: r.id || uuidv4(), filled: false })),
    min_team_size: min_team_size || 3,
    total_credits,
    owner_id,
    owner_name: owner_name || 'User',
    owner_avatar: owner_avatar || null,
    deadline: deadline || null,
    status: 'open',
    room_id: null,
    members: [],
    created_at: new Date().toISOString()
  };
  if (!db.projects) db.projects = [];
  db.projects.unshift(project);

  if (!db.credit_transactions) db.credit_transactions = [];
  db.credit_transactions.push({
    id: uuidv4(), user_id: owner_id, amount: -total_credits,
    type: 'project_escrow_hold',
    reason: `Escrow held for project: ${title}`,
    project_id: project.id, created_at: new Date().toISOString()
  });
  writeDb(db);
  return project;
}

function getAllProjects({ status } = {}) {
  const db = readDb();
  let projects = db.projects || [];
  if (status) projects = projects.filter(p => p.status === status);
  return projects.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function getProjectById(projectId) {
  const db = readDb();
  return (db.projects || []).find(p => p.id === projectId) || null;
}

function getUserProjects(userId) {
  const db = readDb();
  const owned = (db.projects || []).filter(p => p.owner_id === userId);
  const member = (db.projects || []).filter(p => p.members && p.members.some(m => m.user_id === userId));
  const requests = (db.project_requests || []).filter(r => r.contributor_id === userId).map(r => {
    const project = (db.projects || []).find(p => p.id === r.project_id);
    return { ...r, project: project || null };
  });
  return { owned, member, requests };
}

function createProjectRequest({ project_id, role_id, role_name, contributor_id, contributor_name, contributor_avatar, message }) {
  const db = readDb();
  if (!db.project_requests) db.project_requests = [];
  const existing = db.project_requests.find(r =>
    r.project_id === project_id && r.contributor_id === contributor_id
  );
  if (existing) return existing;
  const request = {
    id: uuidv4(), project_id, role_id, role_name,
    contributor_id, contributor_name: contributor_name || 'User',
    contributor_avatar: contributor_avatar || null,
    message: message || '', status: 'pending',
    created_at: new Date().toISOString()
  };
  db.project_requests.unshift(request);
  writeDb(db);
  return request;
}

function getProjectRequests(projectId) {
  const db = readDb();
  return (db.project_requests || []).filter(r => r.project_id === projectId);
}

function _assembleProjectRoom(db, project) {
  if (!db.project_rooms) db.project_rooms = [];
  const participants = [project.owner_id, ...project.members.map(m => m.user_id)];
  const participantInfo = { [project.owner_id]: { name: project.owner_name, avatar_url: project.owner_avatar, role: 'Owner' } };
  project.members.forEach(m => { participantInfo[m.user_id] = { name: m.user_name, avatar_url: m.user_avatar, role: m.role_name }; });
  const room = {
    id: uuidv4(), project_id: project.id, title: project.title,
    notes: '', messages: [], participants, participant_info: participantInfo,
    created_at: new Date().toISOString(), last_message: null
  };
  db.project_rooms.push(room);
  return room;
}

function updateProjectRequestStatus(requestId, status, { project_id } = {}) {
  const db = readDb();
  if (!db.project_requests) db.project_requests = [];
  const request = db.project_requests.find(r => r.id === requestId);
  if (!request) return { request: null, project: null, room: null };
  request.status = status;
  let project = null;
  let room = null;
  if (status === 'accepted') {
    project = (db.projects || []).find(p => p.id === (request.project_id || project_id));
    if (project) {
      const role = project.roles.find(r => r.id === request.role_id);
      if (role) role.filled = true;
      if (!project.members) project.members = [];
      if (!project.members.some(m => m.user_id === request.contributor_id)) {
        project.members.push({
          id: uuidv4(), user_id: request.contributor_id, user_name: request.contributor_name,
          user_avatar: request.contributor_avatar, role_id: request.role_id, role_name: request.role_name,
          credits_allocated: role ? role.credits : 0, joined_at: new Date().toISOString()
        });
      }
      db.project_requests.forEach(r => {
        if (r.project_id === request.project_id && r.role_id === request.role_id && r.id !== requestId && r.status === 'pending')
          r.status = 'rejected';
      });
      if (project.members.length >= project.min_team_size && !project.room_id) {
        room = _assembleProjectRoom(db, project);
        project.room_id = room.id;
        project.status = 'in_progress';
      }
    }
  }
  writeDb(db);
  return { request, project, room };
}

function getProjectRoom(projectId) {
  const db = readDb();
  if (!db.project_rooms) return null;
  const room = db.project_rooms.find(r => r.project_id === projectId);
  if (room) return room;
  const project = (db.projects || []).find(p => p.id === projectId);
  if (project && project.room_id) return db.project_rooms.find(r => r.id === project.room_id) || null;
  return null;
}

function addProjectChatMessage(projectId, { senderId, senderName, content }) {
  const db = readDb();
  if (!db.project_rooms) return null;
  const room = db.project_rooms.find(r => r.project_id === projectId);
  if (!room || room.status === 'closed') return null;
  const message = {
    id: uuidv4(), project_id: projectId,
    sender_id: senderId, sender_name: senderName, content,
    created_at: new Date().toISOString()
  };
  if (!room.messages) room.messages = [];
  room.messages.push(message);
  room.last_message = { content, sender_name: senderName, created_at: message.created_at };
  writeDb(db);
  return message;
}

function saveProjectNotes(projectId, notes) {
  const db = readDb();
  if (!db.project_rooms) return null;
  const room = db.project_rooms.find(r => r.project_id === projectId);
  if (room && room.status !== 'closed') { room.notes = notes; writeDb(db); }
  return room;
}

function completeProject(projectId) {
  const db = readDb();
  const project = (db.projects || []).find(p => p.id === projectId);
  if (!project) throw new Error('Project not found');
  if (project.status === 'completed') throw new Error('Already completed');
  project.status = 'completed';
  project.completed_at = new Date().toISOString();
  if (!db.credit_transactions) db.credit_transactions = [];

  // 1 — Pay all contributors (credits were already escrowed from the owner at creation)
  project.members.forEach(member => {
    const credits = member.credits_allocated || 0;
    if (credits <= 0) return;
    let user = db.users.find(u => u.id === member.user_id);
    if (!user) { user = { id: member.user_id, points: 200, completed_count: 0, rating: 0, reviews_count: 0 }; db.users.push(user); }
    user.points = (user.points || 0) + credits;
    user.completed_count = (user.completed_count || 0) + 1;
    db.credit_transactions.push({
      id: uuidv4(), user_id: member.user_id, amount: credits, type: 'project_payout',
      reason: `Payment for "${member.role_name}" in: ${project.title}`,
      project_id: projectId, created_at: new Date().toISOString()
    });
  });

  // 2 — Increment owner completed_count (credits already deducted at escrow)
  let owner = db.users.find(u => u.id === project.owner_id);
  if (!owner) { owner = { id: project.owner_id, points: 0, completed_count: 0 }; db.users.push(owner); }
  owner.completed_count = (owner.completed_count || 0) + 1;

  // 3 — Close the project room (lock chat)
  if (db.project_rooms) {
    const room = db.project_rooms.find(r => r.project_id === projectId || r.id === project.room_id);
    if (room) {
      room.status = 'closed';
      room.closed_at = new Date().toISOString();
      if (!room.messages) room.messages = [];
      room.messages.push({
        id: uuidv4(), project_id: projectId, sender_id: 'system', sender_name: 'System',
        content: `🎉 Project "${project.title}" marked complete! Credits distributed to all ${project.members.length} contributor(s). Chat is now closed.`,
        created_at: new Date().toISOString()
      });
    }
  }
  writeDb(db);
  return project;
}

function cancelProject(projectId) {
  const db = readDb();
  const project = (db.projects || []).find(p => p.id === projectId);
  if (!project) throw new Error('Project not found');
  if (['completed', 'cancelled'].includes(project.status)) throw new Error('Cannot cancel this project');
  project.status = 'cancelled';
  project.cancelled_at = new Date().toISOString();
  if (!db.credit_transactions) db.credit_transactions = [];
  let owner = db.users.find(u => u.id === project.owner_id);
  if (owner) owner.points = (owner.points || 0) + project.total_credits;
  db.credit_transactions.push({
    id: uuidv4(), user_id: project.owner_id, amount: project.total_credits,
    type: 'project_refund', reason: `Escrow refunded for cancelled project: ${project.title}`,
    project_id: projectId, created_at: new Date().toISOString()
  });
  writeDb(db);
  return project;
}

function saveReport(reportData) {
  const db = readDb();
  if (!db.reports) db.reports = [];
  const report = {
    id: uuidv4(),
    ...reportData,
    status: 'pending',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.reports.push(report);
  writeDb(db);
  return report;
}

module.exports = {
  initDb, readDb, writeDb,
  getAllTasks, createTask, getTaskById, updateTaskStatus,
  createRequest, getRequestById, updateRequestStatus, declineOtherRequests,
  createChatRoom, syncSupabaseRoom, getRoomById, getUserRooms, addMessage, activateRoom, setRoomConnected,
  setRoomWorkDone,
  addNotification, getNotifications, deleteNotification, clearNotificationByReference, markNotificationRead,
  addRating, getRatingsForUser,
  getAllBroadcasts, getTutorBroadcasts, createBroadcast, getBroadcastById,
  publishBroadcast, enrollInBroadcast, getEnrollments, startBroadcast, endBroadcast,
  cancelBroadcast, getUserEnrollments, getUserBalance, autoUpdateBroadcastStatuses,
  getBroadcastChatRoom, addBroadcastChatMessage, saveBroadcastChatNotes, getBroadcastParticipants,
  getBroadcastRequests,
  getUserPosts, getUserRequests,
  confirmStage, getRoomStatus, saveReview, saveDispute,
  addUserSkill, removeUserSkill, getUserSkills,
  getAllSkillProfiles, findBidirectionalMatches,
  createMatchRequest, updateMatchRequestStatus, getMatchRequestsForUser, getMatchRequestBetween,
  updateUserProfile,
  getAdminByEmail, getAllAdmins, addAdmin, removeAdmin,
  addModerationAction, getModerationActionsForReport, saveReport,
  createProject, getAllProjects, getProjectById, getUserProjects,
  createProjectRequest, getProjectRequests, updateProjectRequestStatus,
  getProjectRoom, addProjectChatMessage, saveProjectNotes,
  completeProject, cancelProject
};
