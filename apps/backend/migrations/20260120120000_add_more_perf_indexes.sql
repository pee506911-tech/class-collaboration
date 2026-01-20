-- Additional performance indexes for common query patterns

-- Sessions dashboard listing: WHERE creator_id = ? ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_sessions_creator_created_at ON sessions(creator_id, created_at);

-- Votes lookups: get_my_votes + stats timelines
CREATE INDEX IF NOT EXISTS idx_votes_session_participant ON votes(session_id, participant_id);
CREATE INDEX IF NOT EXISTS idx_votes_session_created_at ON votes(session_id, created_at);

-- Questions sorting: WHERE session_id = ? ORDER BY upvotes DESC, created_at DESC
CREATE INDEX IF NOT EXISTS idx_questions_session_upvotes_created_at ON questions(session_id, upvotes, created_at);

-- Slides ordering: WHERE session_id = ? [AND is_hidden = FALSE] ORDER BY order_index
CREATE INDEX IF NOT EXISTS idx_slides_session_order_index ON slides(session_id, order_index);
CREATE INDEX IF NOT EXISTS idx_slides_session_hidden_order_index ON slides(session_id, is_hidden, order_index);

-- Participants ordering: WHERE session_id = ? ORDER BY joined_at DESC
CREATE INDEX IF NOT EXISTS idx_participants_session_joined_at ON participants(session_id, joined_at);

