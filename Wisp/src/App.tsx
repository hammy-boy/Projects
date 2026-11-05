import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { auth, api, ws } from '@appdeploy/client';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  LogOut,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  UserRound,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';

type Profile = { userId: string; username: string; displayName: string };
type Chat = {
  id: string;
  members: string[];
  createdAt: number;
  otherUser: Profile;
  lastMessage?: Message;
};
type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  createdAt: number;
};

function App() {
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Profile[]>([]);
  const [searching, setSearching] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<'chats' | 'conversation'>(
    'chats'
  );
  const [socketReady, setSocketReady] = useState(false);
  const activeChatRef = useRef<Chat | null>(null);
  const socketRef = useRef<ReturnType<typeof ws.connect> | null>(null);
  activeChatRef.current = activeChat;
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const current = await auth.getUser();
        if (!alive) return;
        setUser(current);
        if (current) {
          const response = await api.get('/api/profile');
          if (!alive) return;
          if (response.data.profile) {
            setProfile(response.data.profile);
            await loadChats();
          } else {
            setDisplayName(current.name || '');
          }
        }
      } catch (err) {
        if (alive) setNotice(errorText(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!user || !profile) return;
    const connection = ws.connect();
    socketRef.current = connection;
    connection.onMessage(event => {
      if (event?.type !== 'entity.update') return;
      const payload = event.payload;
      if (payload?.entity_type !== 'conversation' || !payload?.data?.message)
        return;
      const incoming = payload.data.message as Message;
      if (activeChatRef.current?.id === incoming.conversationId) {
        setMessages(current =>
          current.some(item => item.id === incoming.id)
            ? current
            : [...current, incoming]
        );
      }
      setChats(current =>
        current.map(chat =>
          chat.id === incoming.conversationId
            ? { ...chat, lastMessage: incoming }
            : chat
        )
      );
    });
    connection.onOpen(() => setSocketReady(true));
    connection.onClose(() => setSocketReady(false));
    connection.onError(() => setSocketReady(false));
    connection.ready
      .then(() => setSocketReady(true))
      .catch(() => setSocketReady(false));
    return () => {
      connection.disconnect();
      socketRef.current = null;
      setSocketReady(false);
    };
  }, [user, profile]);

  useEffect(() => {
    if (!activeChat || !socketReady || !socketRef.current?.connectionId) return;
    const conversationId = activeChat.id;
    const connectionId = socketRef.current.connectionId;
    api
      .post(`/api/conversations/${conversationId}/subscribe`, { connectionId })
      .catch(() => {});
    return () => {
      api
        .post(`/api/conversations/${conversationId}/unsubscribe`, {
          connectionId,
        })
        .catch(() => {});
    };
  }, [activeChat?.id, socketReady]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  useEffect(() => {
    if (!search.trim() || !profile) {
      setResults([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const response = await api.get(
          `/api/users/search?q=${encodeURIComponent(search.trim())}`
        );
        setResults(response.data.users || []);
      } catch (err) {
        setNotice(errorText(err));
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, profile]);

  async function loadChats() {
    const response = await api.get('/api/conversations');
    setChats(response.data.conversations || []);
  }

  async function openChat(chat: Chat) {
    setActiveChat(chat);
    setMobilePanel('conversation');
    setSearch('');
    setResults([]);
    try {
      const response = await api.get(`/api/conversations/${chat.id}/messages`);
      setMessages(response.data.messages || []);
    } catch (err) {
      setNotice(errorText(err));
    }
  }

  async function startChat(person: Profile) {
    setBusy(true);
    try {
      const response = await api.post('/api/conversations', {
        targetUserId: person.userId,
      });
      await loadChats();
      const chat = response.data.conversation as Chat;
      await openChat({ ...chat, otherUser: person });
    } catch (err) {
      setNotice(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice('');
    try {
      const response = await api.post('/api/profile', {
        displayName,
        username,
      });
      setProfile(response.data.profile);
      await loadChats();
    } catch (err) {
      setNotice(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !activeChat || busy) return;
    setBusy(true);
    setDraft('');
    try {
      const response = await api.post('/api/messages', {
        conversationId: activeChat.id,
        text,
      });
      const sent = response.data.message as Message;
      setMessages(current =>
        current.some(item => item.id === sent.id) ? current : [...current, sent]
      );
      setChats(current =>
        current.map(chat =>
          chat.id === activeChat.id ? { ...chat, lastMessage: sent } : chat
        )
      );
    } catch (err) {
      setDraft(text);
      setNotice(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await auth.signOut();
    setUser(null);
    setProfile(null);
    setChats([]);
    setActiveChat(null);
    setMessages([]);
  }

  const initials = (name: string) =>
    name
      .split(/\s+/)
      .map(part => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  const activeName = activeChat?.otherUser?.displayName || 'Conversation';
  const groupedMessages = useMemo(() => messages, [messages]);

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="brand-mark">
          <MessageCircle size={23} />
        </div>
        <span>Wisp</span>
        <div className="loader" />
      </div>
    );
  }

  if (!user) {
    return (
      <main className="welcome-screen">
        <div className="welcome-orb orb-one" />
        <div className="welcome-orb orb-two" />
        <section className="welcome-card">
          <div className="brand-lockup">
            <div className="brand-mark">
              <MessageCircle size={22} />
            </div>
            <span> wisp</span>
          </div>
          <div className="welcome-art">
            <div className="bubble bubble-back">hey there</div>
            <div className="bubble bubble-front">you around?</div>
            <Sparkles size={23} />
          </div>
          <p className="eyebrow">A little space to talk</p>
          <h1>
            Good conversations
            <br />
            <em>start with a hello.</em>
          </h1>
          <p className="welcome-copy">
            Find your people, start a chat, and keep the conversation flowing.
            Simple, calm, and just yours.
          </p>
          <button
            className="primary-button welcome-button"
            onClick={() =>
              auth.signInWithRedirect().catch(err => setNotice(errorText(err)))
            }
          >
            Sign up or log in <ArrowUpRight size={18} />
          </button>
          <div className="trust-note">
            <ShieldCheck size={15} /> Your conversations are private to their
            members.
          </div>
          {notice && <p className="notice">{notice}</p>}
        </section>
        <footer className="welcome-footer">
          WISP <span>·</span> WORDS IN SIMPLE PLACES
        </footer>
      </main>
    );
  }

  if (!profile) {
    return (
      <main className="profile-screen">
        <section className="profile-card">
          <div className="brand-lockup">
            <div className="brand-mark">
              <MessageCircle size={22} />
            </div>
            <span> wisp</span>
          </div>
          <div className="profile-icon">
            <UserRound size={26} />
          </div>
          <p className="eyebrow">Make it yours</p>
          <h1>
            How should people
            <br />
            <em>find you?</em>
          </h1>
          <p className="welcome-copy">
            Choose a display name and a unique username. You can share either to
            help someone find you.
          </p>
          <form onSubmit={saveProfile} className="profile-form">
            <label>
              Display name
              <input
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="e.g. Sam"
                maxLength={48}
                required
              />
            </label>
            <label>
              Username
              <div className="username-input">
                <span>@</span>
                <input
                  value={username}
                  onChange={e =>
                    setUsername(
                      e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '')
                    )
                  }
                  placeholder="yourname"
                  minLength={3}
                  maxLength={20}
                  required
                />
              </div>
            </label>
            <p className="field-hint">
              3–20 characters · letters, numbers and underscores
            </p>
            {notice && <p className="notice">{notice}</p>}
            <button className="primary-button" disabled={busy}>
              {busy ? 'Saving…' : 'Continue to Wisp'} <ArrowUpRight size={18} />
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside
        className={`sidebar ${mobilePanel === 'conversation' ? 'mobile-hidden' : ''}`}
      >
        <header className="sidebar-header">
          <div className="brand-lockup">
            <div className="brand-mark">
              <MessageCircle size={19} />
            </div>
            <span> wisp</span>
          </div>
          <button
            className="icon-button"
            title="More options"
            onClick={signOut}
          >
            <MoreHorizontal size={20} />
          </button>
        </header>
        <div className="sidebar-greeting">
          <p className="eyebrow">YOUR SPACE</p>
          <h2>
            Messages<span className="count-pill">{chats.length}</span>
          </h2>
        </div>
        <div className="search-wrap">
          <Search size={17} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Find someone…"
            aria-label="Find someone by name, username or email"
          />
        </div>
        {search.trim() ? (
          <div className="people-results">
            <div className="list-label">
              {searching ? 'SEARCHING…' : 'PEOPLE'}
            </div>
            {results.map(person => (
              <button
                className="person-result"
                key={person.userId}
                onClick={() => startChat(person)}
                disabled={busy}
              >
                <div className="avatar">{initials(person.displayName)}</div>
                <span>
                  <strong>{person.displayName}</strong>
                  <small>@{person.username}</small>
                </span>
                <ArrowUpRight size={16} />
              </button>
            ))}
            {!searching && results.length === 0 && (
              <p className="empty-small">
                No people found. Try a username or exact email.
              </p>
            )}
          </div>
        ) : (
          <div className="chat-list">
            <div className="list-label">RECENT CONVERSATIONS</div>
            {chats.map(chat => (
              <button
                key={chat.id}
                className={`chat-row ${activeChat?.id === chat.id ? 'selected' : ''}`}
                onClick={() => openChat(chat)}
              >
                <div className="avatar">
                  {initials(chat.otherUser?.displayName || '?')}
                </div>
                <span className="chat-row-copy">
                  <strong>{chat.otherUser?.displayName || 'Wisp user'}</strong>
                  <small>
                    {chat.lastMessage?.text ||
                      `@ ${chat.otherUser?.username || 'new chat'}`}
                  </small>
                </span>
                <span className="chat-time">
                  {chat.lastMessage
                    ? new Date(chat.lastMessage.createdAt).toLocaleTimeString(
                        [],
                        { hour: '2-digit', minute: '2-digit' }
                      )
                    : ''}
                </span>
              </button>
            ))}
            {chats.length === 0 && (
              <div className="empty-state">
                <div className="empty-icon">
                  <MessageCircle size={22} />
                </div>
                <strong>No conversations yet</strong>
                <p>Search for someone above and say hello.</p>
              </div>
            )}
          </div>
        )}
        <div className="sidebar-bottom">
          <div className="my-profile">
            <div className="avatar avatar-self">
              {initials(profile.displayName)}
            </div>
            <span>
              <strong>{profile.displayName}</strong>
              <small>@{profile.username}</small>
            </span>
            <button className="icon-button" title="Log out" onClick={signOut}>
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>

      <section
        className={`conversation-panel ${mobilePanel === 'chats' ? 'mobile-hidden' : ''}`}
      >
        {activeChat ? (
          <>
            <header className="conversation-header">
              <button
                className="icon-button mobile-back"
                onClick={() => setMobilePanel('chats')}
              >
                <ArrowLeft size={20} />
              </button>
              <div className="avatar">{initials(activeName)}</div>
              <div className="conversation-person">
                <strong>{activeName}</strong>
                <small>@{activeChat.otherUser?.username || 'wisp-user'}</small>
              </div>
              <div className="connection-state">
                {socketReady ? (
                  <>
                    <span className="online-dot" /> Live
                  </>
                ) : (
                  <>
                    <WifiOff size={14} /> Connecting
                  </>
                )}
              </div>
              <button className="icon-button" title="Conversation details">
                <CircleHelp size={18} />
              </button>
            </header>
            <div className="message-area">
              <div className="conversation-intro">
                <div className="avatar avatar-large">
                  {initials(activeName)}
                </div>
                <h2>{activeName}</h2>
                <p>@{activeChat.otherUser?.username}</p>
                <span>You’re connected on Wisp. Say hello!</span>
              </div>
              <div className="message-list">
                {groupedMessages.map(message => (
                  <div
                    className={`message-line ${message.senderId === user.userId ? 'mine' : 'theirs'}`}
                    key={message.id}
                  >
                    <div className="message-bubble">
                      {message.text}
                      <small>
                        {new Date(message.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                        {message.senderId === user.userId && (
                          <Check size={13} />
                        )}
                      </small>
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
            </div>
            <form className="composer" onSubmit={sendMessage}>
              <div className="composer-box">
                <input
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  placeholder={`Message ${activeName}…`}
                  maxLength={2000}
                />
                <button
                  className="send-button"
                  disabled={!draft.trim() || busy}
                  aria-label="Send message"
                >
                  <Send size={17} />
                </button>
              </div>
              <p>
                Press Enter to send <span>·</span> Keep it kind.
              </p>
            </form>
          </>
        ) : (
          <div className="no-chat">
            <div className="no-chat-art">
              <div className="art-bubble">
                <MessageCircle size={28} />
              </div>
              <Sparkles className="art-spark" size={19} />
            </div>
            <p className="eyebrow">YOUR NEXT CONVERSATION</p>
            <h1>
              Make room for
              <br />
              <em>a good hello.</em>
            </h1>
            <p>Pick a conversation or find someone new to talk to.</p>
            <button
              className="outline-button"
              onClick={() =>
                document
                  .querySelector<HTMLInputElement>('.search-wrap input')
                  ?.focus()
              }
            >
              <Plus size={17} /> Find someone
            </button>
          </div>
        )}
        {notice && (
          <button className="notice-toast" onClick={() => setNotice('')}>
            {notice}
            <X size={15} />
          </button>
        )}
      </section>
    </main>
  );
}

function errorText(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error)
    return String((error as { message: unknown }).message);
  return 'Something went wrong. Please try again.';
}

export default App;
