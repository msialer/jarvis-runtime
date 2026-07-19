# Fase 2 — Memoria activa, handoff y modelado de usuario

## Resumen

Fase 2 convierte a JARVIS en un sistema stateful entre interacciones:

1. **Cliente MCP genérico** en el runtime para llamar a MemPalace (y otros MCP) sin pasar siempre por Kimi.
2. **Checkpoint post-turno** que persiste cada conversación en MemPalace: un drawer semántico y una entrada de diario del agente.
3. **`/handoff` + `CURRENT_STATE.md`** para retomar tareas largas entre sesiones.
4. **Daily logs automáticos** a las 23:30 hora de Lima, con calendario, correos, tareas y métricas.
5. **User modeling ligero** que cada 20 turnos propone actualizaciones de `vault/memory/semantic/USER.md`.

## Archivos nuevos

- `src/mcp-client.js` — cliente MCP stdio genérico.
- `src/tools/mempalace-mcp.js` — wrappers de alto nivel para MemPalace MCP.
- `src/tools/mcp-helpers.js` — wrappers para calendar/gmail/tasks/metrics MCP.
- `src/memory-checkpoint.js` — checkpoint post-turno y fetch de contexto de MemPalace.
- `src/handoff.js` — lectura/escritura de `CURRENT_STATE.md`.
- `src/daily-log.js` — generación de daily logs.
- `src/user-model.js` — extracción de patrones y propuesta de USER.md.

## Archivos modificados

- `src/config.js` — configuración de MCP servers, memory, handoff, daily log y user model.
- `src/tools/mempalace.js` — usa MCP con fallback a CLI.
- `src/index.js` — integra checkpoint, `/handoff`, daily log, user modeling.
- `src/kimi-bridge.js` — renderiza handoff, KG, diario y contexto semántico en el prompt.
- `src/session-manager.js` — tracking de `ownerTurnCount`.

## Comandos nuevos disponibles por WhatsApp

- `/handoff [nota]` — guarda el estado actual de la tarea en `CURRENT_STATE.md`.
- `/handoff clear` — limpia el handoff.
- `/approve-user-model [números]` — aplica actualizaciones propuestas del perfil de usuario.

## Configuración

Ver `src/config.js`:

- `CONFIG.mcpServers` — servidores MCP disponibles para el runtime.
- `CONFIG.memory` — wing/room/agent para checkpoints.
- `CONFIG.dailyLog` — hora y zona horaria del daily log.
- `CONFIG.userModel` — umbral de turnos y path de `USER.md`.

## Tests

```bash
node tests/lcm.test.js
node tests/mcp-client.test.js
node tests/handoff.test.js
node tests/daily-log.test.js
```

## Consideraciones de operación

- El daily log se guarda automáticamente como borrador en `vault/daily/YYYY-MM-DD.md` y se notifica por WhatsApp.
- El user modeling nunca aplica cambios sensibles sin aprobación; los hechos triviales solo se auto-aplican si `autoApplyMinor` está en `true`.
- El runtime mantiene procesos MCP hijos vivos con timeout y reinicio automático.
