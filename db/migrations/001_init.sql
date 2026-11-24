-- Flash: начальная схема.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  timezone      text NOT NULL DEFAULT 'UTC',
  locale        text NOT NULL DEFAULT 'ru',
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  user_agent   text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- Момент — одно записанное или загруженное видео.
CREATE TABLE moments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id     text NOT NULL,                       -- идемпотентность загрузки с устройства
  recorded_at   timestamptz NOT NULL,
  local_date    date NOT NULL,                       -- календарный день пользователя в момент съёмки
  local_time    text NOT NULL,                       -- 'HH:MM' по часам пользователя
  note          text NOT NULL DEFAULT '',
  source        text NOT NULL DEFAULT 'camera',      -- camera | upload
  status        text NOT NULL DEFAULT 'uploading',   -- uploading | processing | ready | failed
  error         text,
  mime          text NOT NULL DEFAULT 'video/mp4',
  ext           text NOT NULL DEFAULT 'mp4',
  expected_size bigint NOT NULL DEFAULT 0,
  size_bytes    bigint NOT NULL DEFAULT 0,
  duration_ms   integer NOT NULL DEFAULT 0,
  width         integer NOT NULL DEFAULT 0,
  height        integer NOT NULL DEFAULT 0,
  has_audio     boolean NOT NULL DEFAULT true,
  original_key  text,
  playback_key  text,
  poster_key    text,
  playback_size bigint NOT NULL DEFAULT 0,
  poster_size   bigint NOT NULL DEFAULT 0,
  favorite      boolean NOT NULL DEFAULT false,
  analysis      jsonb,                               -- { energy: number[], motion: number[] } по секундам
  upload_id     text,
  parts         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{ n, etag, size }]
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_id)
);
CREATE INDEX moments_user_date_idx ON moments(user_id, local_date);
CREATE INDEX moments_user_recorded_idx ON moments(user_id, recorded_at);
CREATE INDEX moments_status_idx ON moments(status) WHERE status <> 'ready';

-- Проект воспоминаний — период записи с финальным фильмом.
CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           text NOT NULL,
  description     text NOT NULL DEFAULT '',
  period_kind     text NOT NULL,                     -- d1 d3 d7 d14 d30 m3 m6 y1 custom open
  start_date      date NOT NULL,
  end_date        date,                              -- NULL = бессрочно
  status          text NOT NULL DEFAULT 'active',    -- active | paused | completed
  pauses          jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{ from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' | null }]
  completed_at    timestamptz,
  cover_kind      text NOT NULL DEFAULT 'auto',      -- auto | preset | moment
  cover_preset    text NOT NULL DEFAULT 'mint',
  cover_moment_id uuid REFERENCES moments(id) ON DELETE SET NULL,
  cover_key       text,
  cover_size      bigint NOT NULL DEFAULT 0,
  cover_version   integer NOT NULL DEFAULT 0,
  film_settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_user_idx ON projects(user_id, status);

-- Один момент может входить в несколько проектов без копирования видео.
CREATE TABLE project_moments (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  moment_id  uuid NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, moment_id)
);
CREATE INDEX project_moments_moment_idx ON project_moments(moment_id);

CREATE TABLE films (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    uuid REFERENCES projects(id) ON DELETE SET NULL,
  kind          text NOT NULL,                       -- day | week | month | year | custom | project
  variant       text NOT NULL,                       -- full | highlights | trailer | mini | extended
  title         text NOT NULL,
  subtitle      text NOT NULL DEFAULT '',
  date_from     date NOT NULL,
  date_to       date NOT NULL,
  style         text NOT NULL DEFAULT 'auto',        -- запрошенный стиль (auto | id)
  style_used    text,
  music         text NOT NULL DEFAULT 'auto',        -- auto | none | id стиля
  music_used    jsonb NOT NULL DEFAULT '[]'::jsonb,  -- id использованных треков
  music_volume  real NOT NULL DEFAULT 0.5,
  orientation   text NOT NULL DEFAULT 'auto',        -- auto | portrait | landscape
  resolution    text NOT NULL DEFAULT 'auto',        -- auto | 720 | 1080 | 1440 | 2160
  status        text NOT NULL DEFAULT 'queued',      -- queued | rendering | ready | failed
  progress      real NOT NULL DEFAULT 0,
  stage         text NOT NULL DEFAULT '',
  error         text,
  width         integer NOT NULL DEFAULT 0,
  height        integer NOT NULL DEFAULT 0,
  duration_ms   integer NOT NULL DEFAULT 0,
  size_bytes    bigint NOT NULL DEFAULT 0,
  moments_count integer NOT NULL DEFAULT 0,
  file_key      text,
  poster_key    text,
  poster_size   bigint NOT NULL DEFAULT 0,
  chapters      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{ title, startMs }]
  auto          boolean NOT NULL DEFAULT false,      -- создан планировщиком
  stale         boolean NOT NULL DEFAULT false,      -- после рендера появились новые моменты
  revision      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  rendered_at   timestamptz
);
CREATE INDEX films_user_idx ON films(user_id, created_at DESC);
CREATE INDEX films_project_idx ON films(project_id);

-- Очередь фоновых задач (монтаж, обработка видео, обложки).
CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  type         text NOT NULL,
  lane         text NOT NULL DEFAULT 'media',        -- media | film
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'queued',       -- queued | running | done | failed
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX jobs_claim_idx ON jobs(lane, status, run_at);

CREATE TABLE push_subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        text NOT NULL UNIQUE,
  p256dh          text NOT NULL,
  auth            text NOT NULL,
  user_agent      text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  failures        integer NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions(user_id);

-- План напоминаний на день: по строке на каждое запланированное уведомление.
CREATE TABLE push_plan (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  slot       integer NOT NULL,
  fire_at    timestamptz NOT NULL,
  status     text NOT NULL DEFAULT 'pending',        -- pending | sent | skipped
  handled_at timestamptz,
  UNIQUE (user_id, local_date, slot)
);
CREATE INDEX push_plan_due_idx ON push_plan(status, fire_at);

-- Журнал отправленных уведомлений; уникальный ключ защищает от дублей.
CREATE TABLE push_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL,
  kind       text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  delivered  integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);

CREATE TABLE app_config (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
