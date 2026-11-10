
/**
 * routes/casinoRoutes.js
 * Mount: app.use('/api', casinoRoutes);
 */

import { Router } from 'express';
import * as c from '../controllers/casinobetController.js';

import { authMiddleware } from '../middleware/authMiddleware.js';

const router = Router();

// Place bet
router.post('/casino/:slug/bet', authMiddleware, c.placeBet);

// Settle round
router.post('/casino/:slug/settle', authMiddleware, c.settleRound);

// Void / refund round
router.post('/casino/:slug/void', authMiddleware, c.voidRound);

// Nation book
router.get('/casino/:slug/book/:roundId', authMiddleware, c.getNationBook);

// My bets
router.get('/casino/:slug/my-bets', authMiddleware, c.myBets);

// Game stats
router.get('/casino/:slug/stats', authMiddleware, c.getStats);

// Get all bets (Admin)
router.get('/casino/admin/all-bets', authMiddleware, c.getAllBets);

export default router;
