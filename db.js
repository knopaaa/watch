// Встроенная база данных в памяти (без установки дополнительных программ)
const rooms = new Map();
const messages = new Map();

module.exports = {
  saveRoom(id, video) { 
    rooms.set(id, video); 
  },
  loadRoom(id) { 
    return rooms.get(id) || null; 
  },
  saveMessage(roomId, name, color, text) {
    if (!messages.has(roomId)) messages.set(roomId, []);
    messages.get(roomId).push({ name, color, text, ts: Date.now() });
    if (messages.get(roomId).length > 100) messages.get(roomId).shift();
  },
  getMessages(roomId, limit = 100) {
    return (messages.get(roomId) || []).slice(-limit);
  }
};
