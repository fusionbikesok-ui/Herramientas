-- E1: pausa explícita y reanudación de claims de ola.
ALTER TABLE pick_wave_claims ADD COLUMN pausada_en TEXT;
ALTER TABLE pick_wave_claims ADD COLUMN pausada_por TEXT;
ALTER TABLE pick_wave_claims ADD COLUMN motivo_pausa TEXT;
