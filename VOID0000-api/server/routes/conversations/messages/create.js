import { Router } from 'express';
import {
  isMessageSendError,
  sendConversationMessage,
} from './sendMessage.js';

const router = Router({ mergeParams: true });

router.post('/', async (req, res) => {
  try {
    const { message } = await sendConversationMessage({
      userId: req.user.id,
      conversationIdentifier: req.params.conversationId,
      body: req.body,
    });

    res.status(201).json({ success: true, message });
  } catch (err) {
    if (isMessageSendError(err)) {
      return res.status(err.status).json(err.body);
    }

    console.error('Message send error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

export default router;
