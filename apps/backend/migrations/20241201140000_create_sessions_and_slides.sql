-- Create sessions and slides tables
-- This migration should run before any migrations that reference these tables

CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(36) PRIMARY KEY,
    creator_id VARCHAR(36) NOT NULL,
    title VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'draft',
    share_token VARCHAR(50),
    current_slide_id VARCHAR(36),
    is_results_visible BOOLEAN DEFAULT FALSE,
    is_presentation_active BOOLEAN DEFAULT FALSE,
    state_version BIGINT NOT NULL DEFAULT 0,
    allow_questions BOOLEAN DEFAULT TRUE,
    require_name BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_sessions_creator (creator_id),
    INDEX idx_sessions_share_token (share_token),
    INDEX idx_sessions_status (status)
);

CREATE TABLE IF NOT EXISTS slides (
    id VARCHAR(36) PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    type VARCHAR(50) NOT NULL,
    content JSON NOT NULL,
    order_index INT NOT NULL,
    is_hidden BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_slides_session (session_id),
    INDEX idx_slides_session_order (session_id, order_index)
);
