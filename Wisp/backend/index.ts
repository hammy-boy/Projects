import { router, json, error, requireAuth } from '@appdeploy/sdk';
import { db } from '@appdeploy/sdk';
import {
  addSubscription,
  removeSubscriptions,
  notifySubscribers,
} from './realtime-subscribers';

type ProfileRecord = {
  userId: string;
  username: string;
  displayName: string;
  email: string;
  createdAt: number;
};
type ConversationRecord = { id: string; members: string[]; createdAt: number };
type MessageRecord = {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  createdAt: number;
};

function cleanProfile(profile: ProfileRecord) {
  return {
    userId: profile.userId,
    username: profile.username,
    displayName: profile.displayName,
  };
}

async function getConversation(conversationId: string) {
  const [conversation] = await db.get<ConversationRecord>('conversations', [
    conversationId,
  ]);
  return conversation;
}

async function isMember(conversationId: string, userId: string) {
  const conversation = await getConversation(conversationId);
  return !!conversation && conversation.members.includes(userId);
}

function conversationIdFor(first: string, second: string) {
  const pair = [first, second].sort();
  return `conv_${pair.join('_')}`;
}

export const handler = router({
  'GET /api/_healthcheck': [async () => json({ message: 'Success' })],

  'GET /api/profile': [
    requireAuth(),
    async ctx => {
      const userId = ctx.user!.userId;
      const [profile] = await db.get<ProfileRecord>('profiles', [userId]);
      return json({ profile: profile ? cleanProfile(profile) : null });
    },
  ],

  'POST /api/profile': [
    requireAuth(),
    async ctx => {
      const userId = ctx.user!.userId;
      const body = (ctx.body || {}) as Record<string, string>;
      const displayName = (body.displayName || '').trim();
      const username = (body.username || '').trim().toLowerCase();
      if (displayName.length < 2 || displayName.length > 48)
        return error('Display name must be 2–48 characters.', 400);
      if (!/^[a-z0-9_]{3,20}$/.test(username))
        return error(
          'Username must be 3–20 characters using letters, numbers or underscores.',
          400
        );

      const { items } = await db.list<ProfileRecord>('profiles', {
        limit: 1000,
      });
      const taken = items.find(
        item =>
          item.userId !== userId && item.username.toLowerCase() === username
      );
      if (taken)
        return error('That username is already taken. Try another one.', 409);

      const profile: ProfileRecord = {
        userId,
        username,
        displayName,
        email: (ctx.user!.email || '').toLowerCase(),
        createdAt: Date.now(),
      };
      const [created] = await db.tx.add('profiles', [
        { id: userId, ...profile },
      ]);
      if (!created) {
        const [updated] = await db.tx.update(
          'profiles',
          [{ id: userId, record: profile }],
          { patch: true }
        );
        if (!updated)
          return error('Could not save your profile. Please try again.', 500);
      }
      return json({ profile: cleanProfile(profile) });
    },
  ],

  'GET /api/users/search': [
    requireAuth(),
    async ctx => {
      const userId = ctx.user!.userId;
      const query = (ctx.query.q || '').trim().toLowerCase();
      if (query.length < 2) return json({ users: [] });
      const { items } = await db.list<ProfileRecord>('profiles', {
        limit: 1000,
      });
      const users = items
        .filter(
          item =>
            item.userId !== userId &&
            (item.username.toLowerCase().includes(query) ||
              item.displayName.toLowerCase().includes(query) ||
              (query.includes('@') && item.email.toLowerCase() === query))
        )
        .slice(0, 20)
        .map(cleanProfile);
      return json({ users });
    },
  ],

  'GET /api/conversations': [
    requireAuth(),
    async ctx => {
      const userId = ctx.user!.userId;
      const { items: allConversations } = await db.list<ConversationRecord>(
        'conversations',
        { limit: 1000 }
      );
      const conversations = allConversations.filter(item =>
        item.members.includes(userId)
      );
      const { items: allMessages } = await db.list<MessageRecord>('messages', {
        limit: 1000,
      });
      const { items: allProfiles } = await db.list<ProfileRecord>('profiles', {
        limit: 1000,
      });
      const result = conversations
        .map(conversation => {
          const otherId =
            conversation.members.find(member => member !== userId) || '';
          const other = allProfiles.find(item => item.userId === otherId);
          const lastMessage = allMessages
            .filter(message => message.conversationId === conversation.id)
            .sort((a, b) => b.createdAt - a.createdAt)[0];
          return {
            ...conversation,
            otherUser: other
              ? cleanProfile(other)
              : {
                  userId: otherId,
                  username: 'unknown',
                  displayName: 'Wisp user',
                },
            lastMessage: lastMessage || null,
          };
        })
        .sort(
          (a, b) =>
            (b.lastMessage?.createdAt || b.createdAt) -
            (a.lastMessage?.createdAt || a.createdAt)
        );
      return json({ conversations: result });
    },
  ],

  'POST /api/conversations': [
    requireAuth(),
    async ctx => {
      const userId = ctx.user!.userId;
      const targetUserId =
        ((ctx.body || {}) as { targetUserId?: string }).targetUserId || '';
      if (!targetUserId || targetUserId === userId)
        return error('Choose another Wisp user.', 400);
      const [target] = await db.get<ProfileRecord>('profiles', [targetUserId]);
      if (!target) return error('That Wisp profile could not be found.', 404);
      const id = conversationIdFor(userId, targetUserId);
      const members = [userId, targetUserId].sort();
      const [created] = await db.tx.add('conversations', [
        { id, members, createdAt: Date.now() },
      ]);
      const conversation = created
        ? { id, members, createdAt: Date.now() }
        : await getConversation(id);
      if (!conversation || !conversation.members.includes(userId))
        return error('Could not open this conversation.', 500);
      return json({
        conversation: { ...conversation, otherUser: cleanProfile(target) },
      });
    },
  ],

  'GET /api/conversations/:id/messages': [
    requireAuth(),
    async ctx => {
      const userId = ctx.user!.userId;
      const conversationId = ctx.params.id;
      if (!(await isMember(conversationId, userId)))
        return error('You do not have access to this conversation.', 403);
      const { items } = await db.list<MessageRecord>('messages', {
        limit: 1000,
      });
      const messages = items
        .filter(message => message.conversationId === conversationId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-100);
      return json({ messages });
    },
  ],

  'POST /api/messages': [
    requireAuth(),
    async ctx => {
      const userId = ctx.user!.userId;
      const body = (ctx.body || {}) as {
        conversationId?: string;
        text?: string;
      };
      const conversationId = body.conversationId || '';
      const text = (body.text || '').trim();
      if (!conversationId || !text || text.length > 2000)
        return error('Write a message up to 2,000 characters.', 400);
      if (!(await isMember(conversationId, userId)))
        return error('You do not have access to this conversation.', 403);
      const createdAt = Date.now();
      const [id] = await db.add('messages', [
        { conversationId, senderId: userId, text, createdAt },
      ]);
      if (!id)
        return error('Message could not be sent. Please try again.', 500);
      const message: MessageRecord = {
        id,
        conversationId,
        senderId: userId,
        text,
        createdAt,
      };
      await notifySubscribers('conversation', conversationId, { message });
      return json({ message });
    },
  ],

  'POST /api/conversations/:id/subscribe': [
    requireAuth(),
    async ctx => {
      const userId = ctx.user!.userId;
      const conversationId = ctx.params.id;
      const connectionId =
        ((ctx.body || {}) as { connectionId?: string }).connectionId || '';
      if (!connectionId) return error('A live connection is required.', 400);
      if (!(await isMember(conversationId, userId)))
        return error('You do not have access to this conversation.', 403);
      await addSubscription('conversation', conversationId, connectionId);
      return json({ ok: true });
    },
  ],

  'POST /api/conversations/:id/unsubscribe': [
    requireAuth(),
    async ctx => {
      const userId = ctx.user!.userId;
      const conversationId = ctx.params.id;
      const connectionId =
        ((ctx.body || {}) as { connectionId?: string }).connectionId || '';
      if (!connectionId) return error('A live connection is required.', 400);
      if (!(await isMember(conversationId, userId)))
        return error('You do not have access to this conversation.', 403);
      await removeSubscriptions('conversation', conversationId, connectionId);
      return json({ ok: true });
    },
  ],
});
