CREATE TABLE talk_sources (
  source_id text PRIMARY KEY,
  demo_run text NOT NULL,
  title text NOT NULL,
  speakers jsonb NOT NULL,
  talk_date date,
  topic_tags jsonb NOT NULL,
  video_url text,
  transcript_url text,
  fictional bool NOT NULL,
  source_metadata jsonb NOT NULL,
  transcript_file_id uuid NOT NULL,
  transcript_sha256 text NOT NULL,
  transcript_bytes int8 NOT NULL CHECK (transcript_bytes >= 0),
  analysis_state text NOT NULL CHECK (analysis_state = 'pending' OR analysis_state = 'complete')
);

CREATE TABLE talk_digests (
  source_id text PRIMARY KEY REFERENCES talk_sources (source_id),
  digest_text text NOT NULL,
  key_points jsonb NOT NULL,
  analysis_metadata jsonb NOT NULL,
  completed_at timestamptz NOT NULL
);
