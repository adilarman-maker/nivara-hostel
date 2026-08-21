const express = require('express');
const db = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Write access (create/update/delete) stays block-scoped for sub-admins.
// Read access does NOT — any admin can view any block's rooms/tenants.
function canManageBlock(user, blockCode) {
  return user.role === 'super' || user.blockCode === blockCode;
}

// GET /api/rooms?block=1 — any admin (super or sub) can READ any block.
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const blockCode = parseInt(req.query.block, 10);
    if (!db.BLOCKS[blockCode]) return res.status(400).json({ error: 'Invalid block' });

    const rooms = await db.listRoomsByBlock(blockCode);
    // Only this block's tenants — not the whole hostel — and a Map for O(1)
    // bed lookups instead of calling .find() once per bed (was O(rooms × beds × tenants)).
    const blockTenants = await db.listTenantsByBlock(blockCode);
    const tenantsByUid = new Map(blockTenants.map((t) => [t.uid, t]));

    const roomsWithBeds = rooms.map((room) => {
      const beds = [];
      for (let bedNumber = 1; bedNumber <= room.bedCount; bedNumber++) {
        const uid = db.buildUid(room.blockCode, room.floorNumber, room.roomNumber, bedNumber);
        const tenant = tenantsByUid.get(uid);
        beds.push({
          bedNumber,
          uid,
          occupied: !!tenant,
          tenant: tenant ? { id: tenant.id, name: tenant.name, uid: tenant.uid } : null,
        });
      }
      return { ...room, beds, canManage: canManageBlock(req.user, blockCode) };
    });

    const floors = {};
    roomsWithBeds.forEach((r) => {
      if (!floors[r.floorNumber]) floors[r.floorNumber] = [];
      floors[r.floorNumber].push(r);
    });

    res.json({ block: db.BLOCKS[blockCode], floors, canManage: canManageBlock(req.user, blockCode) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// POST /api/rooms/floor { blockCode, floorNumber, roomCount } — bulk-create a new floor's rooms
router.post('/floor', requireAuth, requireAdmin, async (req, res) => {
  try {
    const blockCode = parseInt(req.body.blockCode, 10);
    const floorNumber = parseInt(req.body.floorNumber, 10);
    const roomCount = parseInt(req.body.roomCount, 10);

    if (!db.BLOCKS[blockCode]) return res.status(400).json({ error: 'Invalid block' });
    if (!canManageBlock(req.user, blockCode)) {
      return res.status(403).json({ error: `You can only manage the ${db.BLOCKS[req.user.blockCode]?.name} block` });
    }
    if (isNaN(floorNumber) || floorNumber < 0 || floorNumber > 9) {
      return res.status(400).json({ error: 'Floor number must be 0-9' });
    }
    if (isNaN(roomCount) || roomCount < 1 || roomCount > 99) {
      return res.status(400).json({ error: 'Room count must be between 1 and 99' });
    }
    if (await db.floorExists(blockCode, floorNumber)) {
      return res.status(409).json({ error: `Floor ${floorNumber} already exists for ${db.BLOCKS[blockCode].name}` });
    }

    const rooms = await db.createFloorRooms(blockCode, floorNumber, roomCount);
    await db.logAction(
      req.user.name,
      'CREATE_FLOOR',
      `Added floor ${floorNumber} to ${db.BLOCKS[blockCode].name} with ${roomCount} rooms`
    );
    res.status(201).json({ rooms });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// POST /api/rooms/:id/beds — CREATE: add one more bed slot to a room
router.post('/:id/beds', requireAuth, requireAdmin, async (req, res) => {
  try {
    const room = await db.getRoomById(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!canManageBlock(req.user, room.blockCode)) {
      return res.status(403).json({ error: 'You do not have permission to edit this room' });
    }
    if (room.bedCount >= 9) return res.status(400).json({ error: 'A room can have at most 9 beds' });

    const updated = await db.addBedToRoom(room.id);
    await db.logAction(
      req.user.name,
      'ADD_BED',
      `Added bed ${updated.bedCount} to room ${updated.label} in ${db.BLOCKS[updated.blockCode].name}`
    );
    res.json({ room: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// DELETE /api/rooms/:id/beds — DELETE: remove the highest-numbered bed, only if it's empty
router.delete('/:id/beds', requireAuth, requireAdmin, async (req, res) => {
  try {
    const room = await db.getRoomById(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!canManageBlock(req.user, room.blockCode)) {
      return res.status(403).json({ error: 'You do not have permission to edit this room' });
    }
    if (room.bedCount <= 1) return res.status(400).json({ error: 'A room must have at least 1 bed' });

    const uidOfLastBed = db.buildUid(room.blockCode, room.floorNumber, room.roomNumber, room.bedCount);
    const blockTenants = await db.listTenantsByBlock(room.blockCode);
    if (blockTenants.some((t) => t.uid === uidOfLastBed)) {
      return res.status(409).json({ error: `Bed ${room.bedCount} is occupied — remove that tenant first` });
    }

    const updated = await db.removeBedFromRoom(room.id);
    await db.logAction(
      req.user.name,
      'REMOVE_BED',
      `Removed bed ${room.bedCount} from room ${room.label} in ${db.BLOCKS[room.blockCode].name}`
    );
    res.json({ room: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// PUT /api/rooms/:id/beds — UPDATE: set the bed count directly (grow or shrink in one call)
router.put('/:id/beds', requireAuth, requireAdmin, async (req, res) => {
  try {
    const room = await db.getRoomById(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!canManageBlock(req.user, room.blockCode)) {
      return res.status(403).json({ error: 'You do not have permission to edit this room' });
    }

    const newCount = parseInt(req.body.bedCount, 10);
    if (isNaN(newCount) || newCount < 1 || newCount > 9) {
      return res.status(400).json({ error: 'Bed count must be between 1 and 9' });
    }

    if (newCount < room.bedCount) {
      // Shrinking — make sure no occupied bed would be removed
      const blockTenants = await db.listTenantsByBlock(room.blockCode);
      const occupiedUids = new Set(blockTenants.map((t) => t.uid));
      for (let bedNumber = newCount + 1; bedNumber <= room.bedCount; bedNumber++) {
        const uid = db.buildUid(room.blockCode, room.floorNumber, room.roomNumber, bedNumber);
        if (occupiedUids.has(uid)) {
          return res.status(409).json({ error: `Bed ${bedNumber} is occupied — remove that tenant first` });
        }
      }
    }

    const updated = await db.setRoomBedCount(room.id, newCount);
    await db.logAction(
      req.user.name,
      'SET_BED_COUNT',
      `Set room ${room.label} in ${db.BLOCKS[room.blockCode].name} to ${newCount} bed(s)`
    );
    res.json({ room: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

module.exports = router;
