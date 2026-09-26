const express = require('express');
const db = require('../db/database');
const { withOrgScope } = require('../middleware/orgScope');
const { requireAuth, requireAdmin, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

// A sub-admin has full read/write control of their OWN block — same as
// before — but the rest of the app (any other block) is view-only for them.
// Only the Super Admin can manage every block.
function canManageBlock(user, blockCode) {
  return user.role === 'super' || String(user.blockCode) === String(blockCode);
}

// GET /api/rooms?block=1 — any admin (super or sub) can READ any block.
router.get('/', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const blockCode = parseInt(req.query.block, 10);
    const block = await db.getBlock(req.db, req.user.organizationId, blockCode);
    if (!block) return res.status(400).json({ error: 'Invalid block' });

    const rooms = await db.listRoomsByBlock(req.db, req.user.organizationId, blockCode);
    // Only this block's tenants — not the whole hostel — and a Map for O(1)
    // bed lookups instead of calling .find() once per bed (was O(rooms × beds × tenants)).
    const blockTenants = await db.listTenantsByBlock(req.db, req.user.organizationId, blockCode);
    const tenantsByUid = new Map(blockTenants.map((t) => [t.uid, t]));

    const roomsWithBeds = rooms.map((room) => {
      // Only bed numbers that are actually active render at all — a removed
      // bed simply isn't shown, rather than appearing as a ghost/disabled slot.
      const beds = room.activeBedNumbers.map((bedNumber) => {
        const uid = db.buildUid(room.blockCode, room.floorNumber, room.roomNumber, bedNumber);
        const tenant = tenantsByUid.get(uid);
        const isBooked = tenant && tenant.status === 'booked';
        return {
          bedNumber,
          uid,
          occupied: !!tenant && tenant.status === 'active',
          booked: isBooked,
          tenant: tenant ? { id: tenant.id, name: tenant.name, uid: tenant.uid, joinDate: tenant.joinDate, vacateDate: tenant.vacateDate } : null,
        };
      });
      return { ...room, beds, canManage: canManageBlock(req.user, blockCode) };
    });

    const floors = {};
    roomsWithBeds.forEach((r) => {
      if (!floors[r.floorNumber]) floors[r.floorNumber] = [];
      floors[r.floorNumber].push(r);
    });

    res.json({ block, floors, canManage: canManageBlock(req.user, blockCode) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// POST /api/rooms/floor { blockCode, floorNumber, roomCount } — bulk-create a new floor's rooms
router.post('/floor', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const blockCode = parseInt(req.body.blockCode, 10);
    const floorNumber = parseInt(req.body.floorNumber, 10);
    const roomCount = parseInt(req.body.roomCount, 10);

    const block = await db.getBlock(req.db, req.user.organizationId, blockCode);
    if (!block) return res.status(400).json({ error: 'Invalid block' });
    if (!canManageBlock(req.user, blockCode)) {
      const myBlock = req.user.blockCode ? await db.getBlock(req.db, req.user.organizationId, req.user.blockCode) : null;
      return res.status(403).json({ error: `You can only manage the ${myBlock?.name || 'your'} block` });
    }
    if (isNaN(floorNumber) || floorNumber < 0 || floorNumber > 9) {
      return res.status(400).json({ error: 'Floor number must be 0-9' });
    }
    if (isNaN(roomCount) || roomCount < 1 || roomCount > 99) {
      return res.status(400).json({ error: 'Room count must be between 1 and 99' });
    }
    if (await db.floorExists(req.db, req.user.organizationId, blockCode, floorNumber)) {
      return res.status(409).json({ error: `Floor ${floorNumber} already exists for ${block.name}` });
    }

    const rooms = await db.createFloorRooms(req.db, req.user.organizationId, blockCode, floorNumber, roomCount);
    await db.logAction(req.db, req.user.organizationId, 
      req.user.name,
      'CREATE_FLOOR',
      `Added floor ${floorNumber} to ${block.name} with ${roomCount} rooms`
    );
    res.status(201).json({ rooms });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// POST /api/rooms { blockCode, floorNumber, roomNumber, bedCount, position }
// Insert a single room into an existing floor — "add room above/below" from
// the room options menu. position is only used to shape the error/log
// message; the room number itself is explicit (never auto-shifted — see
// createSingleRoom's comment on why room numbers can't be renumbered).
router.post('/', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const blockCode = parseInt(req.body.blockCode, 10);
    const floorNumber = parseInt(req.body.floorNumber, 10);
    const roomNumber = parseInt(req.body.roomNumber, 10);
    const bedCount = req.body.bedCount ? parseInt(req.body.bedCount, 10) : 1;

    const block = await db.getBlock(req.db, req.user.organizationId, blockCode);
    if (!block) return res.status(400).json({ error: 'Invalid block' });
    if (!canManageBlock(req.user, blockCode)) {
      return res.status(403).json({ error: `You can only manage the ${block.name} block` });
    }
    if (!(await db.floorExists(req.db, req.user.organizationId, blockCode, floorNumber))) {
      return res.status(400).json({ error: `Floor ${floorNumber} doesn't exist yet — add the floor first` });
    }
    if (isNaN(roomNumber) || roomNumber < 1 || roomNumber > 99) {
      return res.status(400).json({ error: 'Room number must be between 1 and 99' });
    }
    if (isNaN(bedCount) || bedCount < 1 || bedCount > 9) {
      return res.status(400).json({ error: 'Bed count must be between 1 and 9' });
    }
    if (await db.roomNumberExists(req.db, req.user.organizationId, blockCode, floorNumber, roomNumber)) {
      return res.status(409).json({ error: `Room ${roomNumber} already exists on this floor` });
    }

    const room = await db.createSingleRoom(req.db, req.user.organizationId, blockCode, floorNumber, roomNumber, bedCount);
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'CREATE_ROOM', `Added room ${room.label} to ${block.name}`);
    res.status(201).json({ room });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// POST /api/rooms/:id/reset — vacate every current occupant of this room
// (booked bookings are cancelled outright, active stays are moved out so
// their history is kept) without touching the room/bed structure itself.
// Distinct from DELETE, which removes the room slot entirely.
router.post('/:id/reset', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const room = await db.getRoomById(req.db, req.user.organizationId, req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!canManageBlock(req.user, room.blockCode)) {
      return res.status(403).json({ error: 'You do not have permission to edit this room' });
    }

    const blockTenants = await db.listTenantsByBlock(req.db, req.user.organizationId, room.blockCode);
    const roomUids = new Set(room.activeBedNumbers.map((n) => db.buildUid(room.blockCode, room.floorNumber, room.roomNumber, n)));
    const occupants = blockTenants.filter((t) => roomUids.has(t.uid) && (t.status === 'active' || t.status === 'booked'));

    for (const tenant of occupants) {
      if (tenant.status === 'booked') await db.deleteTenant(req.db, req.user.organizationId, tenant.id);
      else await db.moveOutTenant(req.db, req.user.organizationId, tenant.id);
    }

    const block = await db.getBlock(req.db, req.user.organizationId, room.blockCode);
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'RESET_ROOM',
      `Reset room ${room.label} in ${block?.name} — cleared ${occupants.length} occupant(s), beds kept`);
    res.json({ room, cleared: occupants.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// DELETE /api/rooms/:id — remove the room slot entirely. Refuses if anyone
// currently holds a bed in it (active or booked) — reset or move them out
// first, same rule as deleting a single bed.
router.delete('/:id', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const room = await db.getRoomById(req.db, req.user.organizationId, req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!canManageBlock(req.user, room.blockCode)) {
      return res.status(403).json({ error: 'You do not have permission to delete this room' });
    }

    const blockTenants = await db.listTenantsByBlock(req.db, req.user.organizationId, room.blockCode);
    const roomUids = new Set(room.activeBedNumbers.map((n) => db.buildUid(room.blockCode, room.floorNumber, room.roomNumber, n)));
    const occupied = blockTenants.some((t) => roomUids.has(t.uid) && (t.status === 'active' || t.status === 'booked'));
    if (occupied) {
      return res.status(409).json({ error: 'This room still has a tenant or booking — reset or move them out first' });
    }

    const block = await db.getBlock(req.db, req.user.organizationId, room.blockCode);
    await db.deleteRoomRow(req.db, req.user.organizationId, room.id);
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'DELETE_ROOM', `Deleted room ${room.label} from ${block?.name}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// POST /api/rooms/:id/beds — CREATE: add one more bed slot to a room
router.post('/:id/beds', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const room = await db.getRoomById(req.db, req.user.organizationId, req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!canManageBlock(req.user, room.blockCode)) {
      return res.status(403).json({ error: 'You do not have permission to edit this room' });
    }
    if (room.bedCount >= 9) return res.status(400).json({ error: 'A room can have at most 9 beds' });

    const updated = await db.addBedToRoom(req.db, req.user.organizationId, room.id);
    const block = await db.getBlock(req.db, req.user.organizationId, updated.blockCode);
    await db.logAction(req.db, req.user.organizationId, 
      req.user.name,
      'ADD_BED',
      `Added bed ${updated.bedCount} to room ${updated.label} in ${block?.name}`
    );
    res.json({ room: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// DELETE /api/rooms/:id/beds  { bedNumber }  — remove ONE SPECIFIC empty bed,
// regardless of where it sits (bed 1 can be removed even if beds 2/3 are
// occupied). Omitting bedNumber falls back to the old "remove the top bed"
// behavior, for any caller that hasn't been updated to send it explicitly.
router.delete('/:id/beds', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const room = await db.getRoomById(req.db, req.user.organizationId, req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!canManageBlock(req.user, room.blockCode)) {
      return res.status(403).json({ error: 'You do not have permission to edit this room' });
    }
    if (room.activeBedCount <= 1) return res.status(400).json({ error: 'A room must have at least 1 bed' });

    const bedNumber = req.body.bedNumber ? parseInt(req.body.bedNumber, 10) : Math.max(...room.activeBedNumbers);
    if (!room.activeBedNumbers.includes(bedNumber)) {
      return res.status(400).json({ error: `Bed ${bedNumber} doesn't exist in this room` });
    }

    const uidOfBed = db.buildUid(room.blockCode, room.floorNumber, room.roomNumber, bedNumber);
    const blockTenants = await db.listTenantsByBlock(req.db, req.user.organizationId, room.blockCode);
    if (blockTenants.some((t) => t.uid === uidOfBed)) {
      return res.status(409).json({ error: `Bed ${bedNumber} is occupied — remove that tenant first` });
    }

    const updated = await db.removeBedFromRoom(req.db, req.user.organizationId, room.id, bedNumber);
    const block = await db.getBlock(req.db, req.user.organizationId, room.blockCode);
    await db.logAction(req.db, req.user.organizationId, 
      req.user.name,
      'REMOVE_BED',
      `Removed bed ${bedNumber} from room ${room.label} in ${block?.name}`
    );
    res.json({ room: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// PUT /api/rooms/:id/beds — UPDATE: set the bed count directly (grow or shrink in one call)
router.put('/:id/beds', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const room = await db.getRoomById(req.db, req.user.organizationId, req.params.id);
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
      const blockTenants = await db.listTenantsByBlock(req.db, req.user.organizationId, room.blockCode);
      const occupiedUids = new Set(blockTenants.map((t) => t.uid));
      for (let bedNumber = newCount + 1; bedNumber <= room.bedCount; bedNumber++) {
        const uid = db.buildUid(room.blockCode, room.floorNumber, room.roomNumber, bedNumber);
        if (occupiedUids.has(uid)) {
          return res.status(409).json({ error: `Bed ${bedNumber} is occupied — remove that tenant first` });
        }
      }
    }

    const updated = await db.setRoomBedCount(req.db, req.user.organizationId, room.id, newCount);
    const block = await db.getBlock(req.db, req.user.organizationId, room.blockCode);
    await db.logAction(req.db, req.user.organizationId, 
      req.user.name,
      'SET_BED_COUNT',
      `Set room ${room.label} in ${block?.name} to ${newCount} bed(s)`
    );
    res.json({ room: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

module.exports = router;
