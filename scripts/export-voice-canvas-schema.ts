import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { VoiceCanvasContentSchema, VoiceCanvasGenerationSchema } from '../src/presentation/voice/contracts';
// Generated from the exact client contract; the database consumes JSON, not UI dependencies.
writeFileSync(new URL('../shared/src/lesson/pack/mathCanvas.schema.json', import.meta.url),
  JSON.stringify(z.toJSONSchema(VoiceCanvasContentSchema, { io: 'input' }), null, 2) + '\n');
writeFileSync(new URL('../shared/src/lesson/pack/mathCanvasGeneration.schema.json', import.meta.url),
  JSON.stringify(z.toJSONSchema(VoiceCanvasGenerationSchema, { io: 'input' }), null, 2) + '\n');
