"""Preventive monthly budgets: images separate, conversation and audio shared."""
MONTH="date_trunc('month',NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"

def usage(conn):
    row=conn.execute("SELECT (SELECT COALESCE(sum(reserved_microusd),0) FROM sales_ai_calls WHERE created_at>="+MONTH+") AS text, (SELECT COALESCE(sum(reserved_microusd),0) FROM multimedia_jobs WHERE kind='audio' AND created_at>="+MONTH+") AS audio, (SELECT COALESCE(sum(reserved_microusd),0) FROM multimedia_jobs WHERE kind='image' AND created_at>="+MONTH+") AS images").fetchone()
    return {**row,'conversation_audio':row['text']+row['audio']}

def audio_limit(conn):
    row=conn.execute("SELECT setting_value FROM system_settings WHERE setting_key='sales_openai'").fetchone()
    return int((row['setting_value'] if row else {}).get('monthly_usd',0))*1_000_000
