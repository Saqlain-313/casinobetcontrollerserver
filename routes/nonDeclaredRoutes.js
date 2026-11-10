import express from 'express';

import {
  getNonDeclaredFancies,
  getNonDeclaredMatches,
} from '../controllers/nonDeclaredController.js';

const router = express.Router();

router.get('/getNonDeclaredFancies', getNonDeclaredFancies);
router.get('/getNonDeclaredMatches', getNonDeclaredMatches);

export default router;
