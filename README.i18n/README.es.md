# [IM.codes](https://im.codes)

[English](../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Español](README.es.md) | [Русский](README.ru.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

**Workbench de AI Force autoalojado, de código disponible y sin vendor lock-in: Task Pairs y Execution Pool multi-proveedor, Nodos Controlados y Computer Use detrás de NAT, Escritorio Remoto 4K integrado, Cloud Docs + ONLYOFFICE y colaboración en equipo en tiempo real.**

> Deja de chatear con una sola IA. Dirige una AI Force.<br>
> Un solo workbench: cada modelo y cada máquina bajo tu mando.<br>
> — IM.codes

IM.codes unifica tus agentes de IA, máquinas remotas y documentación del equipo en un solo workbench en tiempo real. **Autoalojado, de código disponible ([BSL 1.1](#licencia)) y sin vendor lock-in** — tu memoria, código, documentos y herramientas permanecen en tu propia infraestructura y puedes combinar o cambiar de modelo y proveedor libremente ([Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), Antigravity CLI, [OpenClaw](https://openclaw.com), [Qwen](https://github.com/QwenLM/qwen-agent), GitHub Copilot, Cursor, OpenCode y más).

> **Nota:** Este archivo es una traducción. **El README en inglés (`../README.md`) es la versión canónica.** Si hay alguna diferencia, prevalece la versión en inglés.

## Pilares principales

| Pilar | Qué ofrece |
|---|---|
| **Task Pairs y Execution Pool (`Pair`)** | Un Brain insignia descompone objetivos en Briefs con dependencias y checklists numerados, despacha pares aislados `Executor × Auditor` en Split View nativo, cubre puntos ciegos de un solo modelo , distribuye el uso entre proveedores y cambia según tu Execution Pool ante límites de cuota con convergencia `PASS` / `REWORK`. |
| **Nodos Controlados y AI Computer Use (`OCU`)** | Convierte máquinas Linux, Windows y macOS detrás de NAT en nodos operados por IA sin IP pública, VPN ni puertos abiertos. Ejecución `exec_remote` acotada, transferencia directa/relé y automatización GUI/CDP mediante `computer_use_call` (`^^(nodeId)`). |
| **Escritorio Remoto 4K integrado** | Integrado directamente en IM.codes sin cuotas adicionales de escritorio remoto bajo tu licencia de IM.codes. Abre escritorios 4K de Windows, macOS y Linux desde navegador o móvil, supervisa hasta 4 equipos en el Muro Desktop y mantén siempre el control humano final. |
| **Cloud Docs y edición colaborativa (`ONLYOFFICE`)** | Cloud Docs + ONLYOFFICE + DocBuilder integrados. Guarda especificaciones, runbooks y AI Skills, inyecta cualquier documento con `&` en el chat y crea, convierte y edita DOCX/XLSX/PPTX/Markdown en equipo. |
| **Colaboración en tiempo real y control de acceso** | Colabora en tiempo real en ordenadores de desarrollo del equipo, Nodos Controlados, sesiones/sub-sesiones y Cloud Docs por usuario o grupo (`viewer` o `participant`) con revocación en un clic; grupos privados aíslan tus equipos personales y familiares. |
| **Sincronización de 3 pantallas e iPhone Duo** | Continuidad fluida entre escritorio, tablet, **iPhone Duo / Plegable**, móvil y Apple Watch con pestañas y paneles sincronizados. |

## Capturas

### Escritorio

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-sidebar.png"><img src="../landing/imcodes-sidebar.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes0.png"><img src="../landing/imcodes0.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes1.png"><img src="../landing/imcodes1.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes2.png"><img src="../landing/imcodes2.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-nodes.png"><img src="../landing/imcodes-nodes.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-clouddocs.png"><img src="../landing/imcodes-clouddocs.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes3.png"><img src="../landing/imcodes3.png" width="24%" /></a>
</p>

### iPad / Tableta

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-ipad2.png"><img src="../landing/imcodes-ipad2.png" width="48%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-ipad3.png"><img src="../landing/imcodes-ipad3.png" width="48%" /></a>
</p>

### iPhone Duo / Plegable

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-duo1.png"><img src="../landing/imcodes-duo1.png" width="48%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-duo2.png"><img src="../landing/imcodes-duo2.png" width="48%" /></a>
</p>

### Móvil

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m0.png"><img src="../landing/imcodes-m0.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m1.png"><img src="../landing/imcodes-m1.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m2.png"><img src="../landing/imcodes-m2.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m3.png"><img src="../landing/imcodes-m3.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m4.png"><img src="../landing/imcodes-m4.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m5.png"><img src="../landing/imcodes-m5.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m6.png"><img src="../landing/imcodes-m6.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m7.png"><img src="../landing/imcodes-m7.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m8.png"><img src="../landing/imcodes-m8.png" width="18%" /></a>
</p>

### Apple Watch

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch1.png"><img src="../landing/imcodes-watch1.png" width="31%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch0.png"><img src="../landing/imcodes-watch0.png" width="31%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch2.png"><img src="../landing/imcodes-watch2.png" width="31%" /></a>
</p>

La compatibilidad con Apple Watch cubre monitorización rápida de sesiones, contadores de no leídos, notificaciones push y respuestas rápidas desde la muñeca.

## Task Pairs y Execution Pool multi-proveedor

Coordina múltiples modelos de IA como un equipo de ingeniería disciplinado en lugar de depender de un solo modelo en una ventana de chat.

- **Descomposición por Brain y dependencias.** Un Brain insignia divide objetivos en Briefs con dependencias y checklists numerados (`pair_create`, `pair_task_update`) en worktrees o directorios aislados.
- **Execution Pool multi-proveedor.** Combina modelos de Claude Code, Codex, Antigravity CLI, Qwen y más para cubrir puntos ciegos , distribuir el uso entre proveedores y cambiar según la configuración del Execution Pool ante límites de cuota.
- **Split View nativo (`Executor × Auditor`).** Supervisa implementación y auditoría en paralelo con actualización de checklist y convergencia estructurada `PASS` / `REWORK`.
- **Global Task Mode sin ataduras.** Orquesta flujos multifase entre servidores y cambia de modelo o proveedor en cualquier momento.

## Nodos Controlados y Escritorio Remoto 4K integrado

Convierte equipos Linux, Windows y macOS detrás de NAT en nodos operados por IA y escritorios remotos accesibles para humanos sin IP pública, VPN ni redirección de puertos.

- **Una AI Force, múltiples máquinas.** Escribe `^` (o `^^(nodeId)`) para ejecutar `exec_remote`, transferir archivos o automatizar GUI y navegador CDP con `computer_use_call` y [Open Computer Use](https://github.com/iFurySt/open-codex-computer-use) (Leo, MIT).
- **Escritorio Remoto 4K integrado.** Abre escritorios Windows, macOS y Linux en navegador o móvil con navegación táctil y ratón virtual.
- **Muro Desktop de 4 mosaicos.** Supervisa hasta cuatro máquinas a la vez manteniendo siempre el control humano final.
- **Credenciales independientes y acceso revocable.** Desactiva o revoca el acceso de cualquier nodo en un clic.

## Cloud Docs y edición colaborativa

Cloud Docs integrado con ONLYOFFICE y DocBuilder para mantener especificaciones, runbooks y AI Skills junto al código.

- **Inyección instantánea con `&`.** Escribe `&` en el composer o usa la herramienta MCP `cloud_docs` para listar, leer, editar, convertir y compartir documentos DOCX/XLSX/PPTX/Markdown.

## Colaboración en equipo en tiempo real (equipos, servidores y escritorios)

Trabaja en equipo en tiempo real sobre ordenadores de desarrollo dedicados, Nodos Controlados, sesiones vivas, sub-sesiones y Cloud Docs — igual que un escritorio remoto y pair programming sobre el mismo proyecto — con roles `viewer` (observación de solo lectura) o `participant` (pair programming, envío de prompts y operación en nodos autorizados), revocación en un clic y grupos privados para máquinas personales.

## Descarga

<a href="https://apps.apple.com/us/app/im-codes/id6761014424"><img src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" height="40" alt="Download on the App Store" /></a>

Compatible con iPhone, iPad y Apple Watch. También disponible como [web app](https://app.im.codes).

## Por qué

Cuando te alejas del escritorio, la mayoría de los flujos con coding agents se rompen. El agente sigue ejecutándose en un terminal, pero continuar normalmente implica SSH, `tmux attach`, escritorios remotos o esperar hasta volver al portátil.

Ese problema de acceso es solo la mitad. El trabajo complejo con coding agents también necesita un criterio más estable: un solo modelo puede caer en patrones familiares, pasar por alto problemas o producir respuestas inestables en tareas difíciles. Cambiar de provider puede aportar otra perspectiva, pero sin contexto compartido también puede perder el hilo.

[IM.codes](https://im.codes) está pensado para ambas necesidades. Mantiene esas sesiones al alcance desde móvil o web: abrir el terminal, inspeccionar archivos y cambios Git, previsualizar localhost desde otro dispositivo, recibir notificaciones cuando el trabajo termina, invitar a otra persona a la misma sesión o servidor y mantener varios agentes en marcha sobre tu propia infraestructura. También combina "Shared Agent Context y memoria" con "Auditoría cross-modelo y discusiones Team": la recuperación duradera viene de resúmenes del trabajo completado, mientras que la discusión Team es revisión cross-modelo estructurada antes de que el código aterrice. No vuelve perfecto el resultado, pero reduce puntos ciegos de un solo modelo y ayuda a que el trabajo complejo converja con más revisión.

No es otro IDE de IA ni un cliente genérico de terminal remota. Es la capa de mensajería, memoria y revisión alrededor de coding agents basados en terminal.

## OpenSpec Auto Deliver

Para cambios basados en OpenSpec, Auto Deliver convierte un change folder en una ejecución de entrega supervisada de extremo a extremo: revisión proposal/spec, implementación, validación, auditoría Team, scoring automático por módulo, gates de retrabajo y handoff final visible.

- **Pipeline de cambio con un clic.** Se lanza desde una sesión de coding transport-backed. IM.codes resuelve la sesión propietaria, bloquea el carril Team para evitar ejecuciones en conflicto, lee `tasks.md` y mantiene una proyección viva en la UI.
- **Auditoría spec antes de implementar.** El audit-repair opcional de propuesta/spec usa el flujo Team normal (por defecto `audit>review>plan`) y lee un JSON autoritativo en vez de confiar en resúmenes de chat.
- **Bucle de implementación guiado por tareas.** El daemon envía prompts de implementación enfocados a la misma sesión, trabaja solo en ese cambio OpenSpec, sigue tareas checked/unchecked y muestra candidatos seguros de comandos de validación descubiertos en manifests del proyecto.
- **Scoring automático por módulo.** Cada auditoría produce puntuaciones estructuradas para `spec`, `tasks`, `implementation`, `tests` y `risk`, con evidencia y resumen visibles en los detalles de ejecución.
- **Auditoría de implementación y gates de retrabajo.** El veredicto final con puntuación — `PASS`, `REWORK` o `BLOCKED` — decide si la ejecución pasa, repara mientras haya límites o requiere decisión humana.
- **Fail-closed y control humano.** Auto Deliver pide intervención humana ante salida de auditoría inválida, límites agotados, interferencia manual, estado Team incompatible o tareas ilegibles. No hace stage, commit ni push de código.

## Programación colaborativa

Colabora en tiempo real en una pestaña, sub-sesión o equipo de desarrollo del equipo con otro compañero. Usa `viewer` para review de solo lectura o `participant` cuando un teammate deba hacer pair programming y enviar prompts a las sesiones cubiertas. Los mensajes colaborativos llevan actor label y el acceso puede degradarse o revocarse desde la UI.

## Shared Agent Context y memoria

IM.codes convierte continuamente el trabajo ya resuelto de los agentes en memoria reutilizable y vuelve a inyectar ese contexto en sesiones futuras.

- **Se guarda problema → solución, no ruido de logs.** Solo se materializan las salidas finales `assistant.text`; se excluyen deltas en streaming, tool calls, tool results y ruido intermedio.
- **Memoria personal con sincronización opcional en la nube.** La memoria cruda y la procesada permanecen siempre en local; los resúmenes procesados pueden sincronizarse opcionalmente con un pool en la nube a nivel de usuario compartido entre tus dispositivos.
- **Enterprise Shared Context consultable.** Los equipos pueden publicar memoria reutilizable en ámbitos workspace/project, inspeccionarla desde la UI, consultarla y ver estadísticas, en lugar de esconder contexto dentro de prompts invisibles. Esta parte sigue en desarrollo activo y todavía no ha pasado pruebas completas de producción.
- **Recuperación multilingüe.** La búsqueda semántica local y el recall del servidor con pgvector usan embeddings multilingües para encontrar soluciones relacionadas entre inglés, chino, japonés, coreano, español, ruso y repos mixtos.
- **Inyección automática donde importa.** El historial relevante se inyecta tanto por mensaje como al iniciar la sesión, con tarjetas en la timeline que muestran qué se recuperó, por qué, la puntuación de relevancia, el número de recalls y el último uso.
- **Visible y controlable por el usuario.** La UI de Shared Context separa raw events, processed summaries, cloud memory y enterprise memory, con controles de consulta, vista previa, archive/restore y configuración de procesamiento.

## Herramientas MCP gestionadas

IM.codes expone un servidor stdio MCP gestionado por el daemon a los providers basados en SDK compatibles. Los agentes reciben una única superficie de herramientas con alcance de runtime para memoria, mensajería agent-to-agent y seguimientos programados, sin tokens de autenticación crudos ni comandos shell improvisados.

- **Recuperación de memoria y procedencia.** `search_memory` busca en el namespace de memoria ligado al llamador: trabajo previo, historial del proyecto, decisiones, preferencias, bugs, commits, despliegues y contexto discutido anteriormente. `list_memory_summaries` recupera resúmenes compactos recientes sin consulta. Los resultados incluyen refs compactos y `projectionId`; `get_memory_sources` expande un hit relevante en fragmentos de procedencia cuando el modelo necesita instrucciones previas exactas, detalles de bugs, contexto de commit/despliegue o evidencia fuente.
- **Escrituras de memoria.** `save_observation` guarda hechos útiles, decisiones o notas de implementación como candidatos de memoria privada del usuario; `save_preference` guarda preferencias estables por la ruta explícita de preferencias.
- **Mensajería de agentes.** `send_list_targets` enumera sesiones hermanas del proyecto actual, y `send_message` envía mensajes con alcance, referencias opcionales a rutas de archivos, solicitudes de respuesta o broadcasts mediante el mismo pipeline protegido de `imcodes send`.
- **Programación Cron.** `cron_create`, `cron_list`, `cron_update` y `cron_delete` gestionan envíos estructurados futuros para recordatorios, comprobaciones recurrentes, reviews delegadas o seguimientos Team programados, con campos de target/session/project y datos opcionales de expiración/zona horaria.
- **Identidad de runtime y seguridad.** Las llamadas se vinculan en runtime a la session, project, user y server actuales de IM.codes. Los agentes no pueden falsificar namespace, user, server, token ni campos de routing; Memory, Send y Cron quedan protegidos por sus feature gates base y por kill-switches MCP.
- **Visibilidad operativa.** La UI de Shared Context muestra disponibilidad MCP por provider, estado de tool-family gates, razones de degradación, hora de actualización y llamadas recientes redactadas por el daemon para confirmar si el modelo realmente tiene Memory, Send y Cron disponibles.

## Ejecución Supervisada y Auto Audit

IM.codes puede conducir sesiones de agent compatibles turno a turno — un supervisor con tus propias instrucciones evalúa cada turno completado en el límite idle y decide auto-continuar, devolver el control o disparar un bucle de auditoría, en lugar de que tengas que escribir "continue" cada ronda.

- **Modos Auto por sesión.** Configura `off`, `supervised` o `supervised_audit` por sesión, en vez de forzar una sola política en todo el sistema.
- **Comprobaciones de finalización en el límite idle.** Cuando un turno termina, IM.codes puede clasificarlo como `complete`, `continue` o `ask_human` y enviar el siguiente continue prompt dentro de la misma sesión.
- **Automatización fail-closed.** Auto supervision permanece visible en la timeline y en el footer, usa decisiones estructuradas y te devuelve el control si hay timeout, salida inválida o mala configuración.
- **Bucle opcional audit → rework.** En `supervised_audit`, un turno completado puede entrar automáticamente en un pipeline de auditoría y reenviar un brief de retrabajo a la misma sesión antes de devolverte el control.
- **Valores globales + overrides por sesión.** Define una vez el backend/modelo/timeout por defecto del supervisor y, cuando haga falta, sobrescribe backend/modelo/timeout, modo de auditoría e instrucciones personalizadas en cada sesión.
- **Pensado para flujos reales de IM.codes.** Auto supervision entiende flujos de OpenSpec, revisiones Team y coordinación entre agentes con `imcodes send` como pasos válidos del agente, no como una razón inmediata para parar y pedir a un humano.

## Funciones

### Alias privados

Guarda fragmentos de texto reutilizables vinculados al propietario y búscalos escribiendo `;` en el composer, o inserta directamente un marcador `;;(name)`. El mensaje mantiene visible el marcador mientras IM.codes resuelve y entrega el valor fuera de banda. Los agentes también pueden crear, buscar, editar y resolver alias mediante herramientas MCP gestionadas; los listados masivos solo exponen metadatos, evitando que una sola llamada vuelque todos los valores al contexto del modelo.

### Nodos controlados

Registra uno o varios ordenadores, escribe `^` para elegir un destino (o inserta `^^(name)`) y permite que los agentes autorizados trabajen en la máquina seleccionada. Pueden ejecutar comandos con alcance, transferir archivos individuales y usar herramientas Computer Use tipadas, lo que permite operar y coordinar una flota desde la misma conversación. La ejecución sigue bajo control del propietario y puede revocarse; cada nodo usa credenciales independientes y queda fuera de las listas normales de server/session. Los enlaces de descarga caducan, pero el instalador descargado puede conservarse y reutilizarse.

### Control de escritorio remoto

Los nodos Windows compatibles ofrecen escritorio remoto en el navegador a Owners y Participants autorizados. Permite alternar entre control y solo vista, cambiar pantalla y resolución, y colaborar con varios espectadores o controladores autorizados. En móvil, la navegación táctil y el ratón virtual permiten manejar el escritorio desde un teléfono o una tableta.

El escritorio remoto selecciona automáticamente la conexión disponible y el acceso puede revocarse en cualquier momento. **Actualmente está disponible en Windows; los nodos macOS y Linux conservan las demás capacidades, con soporte de escritorio remoto previsto.**

### Computer Use y automatización del navegador

Los agentes SDK compatibles pueden controlar aplicaciones de escritorio mediante herramientas Computer Use tipadas. La ruta multiplataforma para aplicaciones de escritorio integra [Open Computer Use](https://github.com/iFurySt/open-codex-computer-use), de Leo ([iFurySt](https://github.com/iFurySt)), publicado con licencia MIT; se acredita expresamente a ese proyecto por esta capacidad integrada.

La automatización del navegador es una función independiente implementada por IM.codes directamente sobre Chrome DevTools Protocol (CDP). Permite abrir, inspeccionar, navegar, hacer clic, rellenar y evaluar páginas; devuelve texto estructurado por defecto y una captura opcional solo cuando se solicita. El navegador gestionado también expone un endpoint CDP limitado al loopback para que scripts locales de Python o Node reutilicen la misma instancia activa.

### Terminal remota
Acceso completo al terminal de tus sesiones de agente desde cualquier navegador, sin SSH, VPN ni port forwarding. Puedes alternar entre modo terminal bruto y una vista de chat estructurada con tool calls, bloques de thinking y salida en streaming.

### Navegador de archivos y cambios Git
Explora archivos del proyecto en árbol, sube y descarga archivos, revisa estado Git con conteo de líneas añadidas y eliminadas, y abre vistas previas flotantes con resaltado de sintaxis, diff y vista previa HTML segura. Los enlaces locales en el chat también pueden mostrar imágenes en línea y ampliarlas en un lightbox flotante.

### Vista previa web local
Previsualiza tu servidor de desarrollo local desde cualquier dispositivo sin desplegar nada. El daemon hace proxy del tráfico `localhost` a través de un túnel WebSocket seguro.

### Móvil, reloj y notificaciones
Soporte completo para móvil, autenticación biométrica, notificaciones push, entrada interactiva para sesiones shell y respuestas rápidas desde Apple Watch.

### OpenSpec Auto Deliver
Ejecuta un cambio guiado por spec mediante un pipeline estructurado: auditoría proposal/spec, prompts de implementación, sugerencias de validación basadas en manifests, auditoría/retrabajo Team, scoring automático de spec/tasks/implementation/tests/risk y handoff fail-closed visible.

### Programación colaborativa
Colabora en una sesión viva para pair programming, o invita a compañeros a un workspace de servidor de desarrollo con alcance mediante roles viewer/participant.

### Auditoría cross-modelo y discusiones Team
La salida de un solo modelo no debería confiarse ciegamente. Las discusiones Team permiten que múltiples agentes — de distintos proveedores y estilos de pensamiento — colaboren en el análisis del mismo código antes de escribir una sola línea. Cada ronda sigue un pipeline multifase personalizable, donde cada agente lee todas las contribuciones anteriores. Diferentes modelos detectan diferentes tipos de problemas. Esta revisión cruzada entre proveedores encuentra problemas que un solo modelo suele pasar por alto antes de la implementación, reduciendo el retrabajo.

Modos integrados: `audit` (pipeline estructurado audit → review → plan), `review`, `discuss` y `brainstorm` — o define tu propia secuencia de fases. Funciona con Claude Code, Codex, Antigravity CLI y Qwen.

### Agentes transport con streaming
Soporte nativo de streaming para agentes transport como OpenClaw y Qwen, sin scraping de terminal.

### Superficie MCP gestionada
Los providers SDK compatibles pueden recibir automáticamente la superficie MCP gestionada de diez herramientas de IM.codes: búsqueda/fuentes de memoria, captura de observaciones y preferencias, Send con alcance y programación Cron. La UI informa estados ready/degraded por provider para saber si Memory, Send y Cron están realmente disponibles para ese modelo.

### Comunicación agente a agente
Los agentes pueden enviarse mensajes directamente mediante `imcodes send`.

El mismo flujo está disponible para agentes SDK mediante MCP: `send_list_targets` descubre targets hermanos válidos y `send_message` envía texto con alcance, referencias de archivos, solicitudes de respuesta o broadcasts sin exponer credenciales de routing crudas.

```bash
imcodes send "Plan" "review the changes in src/api.ts"
imcodes send "Cx" "run tests" --reply
imcodes send --all "migration complete, check your end"
```

También puedes usar sesiones `script` para automatizar flujos personalizados.

```python
# monitor.py — watch a log file, trigger agent when errors appear
import subprocess, time

while True:
    with open("/var/log/app.log") as f:
        for line in f:
            if "ERROR" in line:
                subprocess.run([
                    "imcodes", "send", "Claude",
                    f"Fix this error and write the patch to /tmp/fix.patch:
{line}"
                ])
    time.sleep(30)
```

```bash
# Webhook → agent: GitHub webhook handler triggers code review
curl -X POST https://your-server/webhook -d '{"pr": 42}' \
  && imcodes send "Gemini" "review PR #42, write summary to /tmp/review.md"

# CI → agent: post-build trigger
imcodes send "Claude" "tests failed on main, check CI log at /tmp/ci.log and fix" --reply
```

### Selector `@` inteligente
`@` busca archivos del proyecto; `@@` selecciona agentes para despacho Team.

### Gestión de múltiples servidores y sesiones
Conecta varias máquinas de desarrollo a un único panel.

### Barra lateral estilo Discord
Barra de iconos de servidor, árbol jerárquico de sesiones, contadores de no leídos y paneles fijados.

### Paneles fijables
Cualquier ventana flotante se puede fijar a la barra lateral.

### Panel del repositorio
Consulta issues, PRs, ramas, commits y ejecuciones CI/CD desde la app.

### Tareas programadas (Cron)
Automatiza flujos de agentes recurrentes con programación estilo cron.

Los agentes SDK pueden gestionar el mismo scheduler mediante MCP con `cron_create`, `cron_list`, `cron_update` y `cron_delete`, creando envíos estructurados para recordatorios, comprobaciones recurrentes, reviews delegadas o follow-ups mientras permanecen ligados a la identidad actual de proyecto/session.

### Sincronización entre dispositivos
Orden de pestañas y paneles fijados se sincronizan a través de la API de preferencias del servidor.

### Internacionalización
La interfaz soporta 7 idiomas.

### Actualizaciones OTA
El daemon puede actualizarse vía npm y dispararse desde la web.

## Lo que IM.codes no es

- No es otro IDE de IA
- No es solo un wrapper de chat
- No es solo un cliente de terminal remota
- No reemplaza Claude Code, Codex, Antigravity CLI, OpenClaw o Qwen
- Es la capa de mensajería y control alrededor de ellos

## Arquitectura

```
You (browser / mobile)
        ↓ WebSocket
Server (self-hosted)
        ↓ WebSocket
Daemon (your machine)
        ↓ tmux / transport / managed MCP
AI Agents (Claude Code / Codex / Antigravity CLI / OpenClaw)
        ↔ imcodes send (agent-to-agent)
```

El daemon se ejecuta en tu máquina y gestiona sesiones process-backed mediante tmux y sesiones transport-backed mediante SDKs o protocolos de red. También posee el servidor MCP gestionado que expone herramientas Memory, Send y Cron con alcance de runtime a los providers SDK compatibles. El servidor reenvía las conexiones entre tus dispositivos y el daemon. Todo permanece en tu propia infraestructura.

## Instalación

```bash
curl -fsSL https://im.codes/install.sh | bash
# fallback: npm install -g imcodes
```

## Inicio rápido

> **Se recomienda encarecidamente autoalojar.** La instancia compartida `app.im.codes` es solo para pruebas.

```bash
imcodes bind https://app.im.codes/bind/<api-key>
```

Este comando vincula tu máquina, inicia el daemon, lo registra como servicio del sistema y hace que la máquina aparezca en el panel web/móvil.

### Conexión OpenClaw

Si OpenClaw está ejecutándose localmente, conecta IM.codes al gateway de OpenClaw en la máquina donde corre el daemon:

```bash
imcodes connect openclaw
```

Esto:

- se conecta por defecto a `ws://127.0.0.1:18789`
- reutiliza automáticamente el token desde `~/.openclaw/openclaw.json`
- sincroniza sesiones principales e hijas de OpenClaw en IM.codes
- guarda la configuración en `~/.imcodes/openclaw.json`
- reinicia el daemon para permitir la reconexión automática

```bash
imcodes connect openclaw --url ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=... imcodes connect openclaw
imcodes connect openclaw --url wss://gateway.example.com
```

Notas:

- las URLs remotas `ws://` sin TLS requieren `--insecure`
- usa `imcodes disconnect openclaw` para eliminar la configuración guardada
- este flujo solo se ha probado en macOS

## Autoalojado

### Configuración en un solo comando

```bash
curl -fsSL https://im.codes/install.sh | bash   # fallback: npm install -g imcodes
mkdir imcodes && cd imcodes
imcodes setup --domain imc.example.com
```

### Configuración manual

```bash
git clone https://github.com/im4codes/imcodes.git && cd imcodes
./gen-env.sh imc.example.com        # generates .env with random secrets, prints admin password
docker compose up -d
```

El `docker-compose.yml` generado ya usa `pgvector/pgvector:pg18` para PostgreSQL.

## Windows (experimental)

Windows está soportado de forma nativa mediante ConPTY.

```powershell
irm https://im.codes/install.ps1 | iex
# fallback: npm install -g imcodes
imcodes bind https://app.im.codes/bind/<api-key>
```

```cmd
imcodes upgrade
```

```cmd
imcodes repair-watchdog
```

```cmd
npm prefix -g
```

```cmd
setx PATH "<npm-prefix-path>;%PATH%"
```

```
%USERPROFILE%\.imcodes\watchdog.log
```

## Requisitos

- macOS o Linux
- Windows (experimental) vía ConPTY
- Node.js >= 22
- tmux en Linux/macOS
- Al menos un coding agent: Claude Code, Codex, Antigravity CLI, OpenClaw o Qwen

## Acerca de

Este es un proyecto personal. Yo prácticamente no escribí código: fue construido casi por completo por [Claude Code](https://github.com/anthropics/claude-code), con contribuciones importantes de [Codex](https://github.com/openai/codex) y Antigravity CLI.

## Descargo de responsabilidad

IM.codes es un proyecto independiente de código disponible (source-available) y no está afiliado, respaldado ni patrocinado por Anthropic, OpenAI, Google, Alibaba, OpenClaw ni ninguna otra empresa mencionada.

## Licencia

[Business Source License 1.1 (BSL 1.1)](../LICENSE) — [Guía de licencia comercial](../COMMERCIAL-LICENSE.md) | [Avisos de terceros](../THIRD_PARTY_NOTICES.md)

- **Uso no productivo y uso personal en producción:** El uso no productivo (evaluación, pruebas, desarrollo), la copia, modificación y redistribución conforme manteniendo avisos de derechos y marcas son gratuitos para cualquier tamaño de organización bajo BSL 1.1; el uso personal por personas físicas para desarrollo personal, aprendizaje, investigación o autoalojamiento personal en sus propios dispositivos o servidores (no desplegado centralmente ni compartido en una organización, ni para servicios comerciales alojados/SaaS/marca blanca a terceros) es gratuito permanentemente, sin importar el tamaño del empleador.
- **Equipos pequeños en producción interna:** Cubierto gratis bajo la Concesión de Uso Adicional solo si se cumplen **ambas** condiciones **agregadas entre entidad legal, filiales y todas las instancias**: **<= 5** usuarios activos/asientos **y** **<= 50** personas en toda la organización.
- **Fuera de la Concesión Adicional (licencia comercial):** Antes de la fecha de cambio, el uso en producción que supere cualquier límite agregado (`6/50` o `5/51`), así como el uso en producción para servicios alojados/gestionados, SaaS multi-tenant o reventa de marca blanca (incluso para 1 persona), queda fuera de la Concesión de Uso Adicional y requiere licencia comercial vía `support@im.codes`.
- **Fecha de cambio:** Se convierte a [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) 4 años después de la publicación de cada versión (`2030-11-26` para esta versión).

© 2026 [IM.codes](https://im.codes)
