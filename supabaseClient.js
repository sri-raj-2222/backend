const { createClient } = require('@supabase/supabase-js');

// Accept both plain and VITE_-prefixed env var names.
// The root project .env uses VITE_ prefix (for the frontend bundler),
// but the server .env may use the plain names. Fall back gracefully.
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY         ||
  process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase environment variables (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

module.exports = { supabase };
