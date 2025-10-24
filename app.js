(() => {
  'use strict';

  const MIN_VIEWPORT_WIDTH = 1024;
  const METHOD_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const REQUIRED_LIKERT_OPTIONS = [
    '1 - Strongly disagree',
    '2 - Disagree',
    '3 - Slightly disagree',
    '4 - Neutral',
    '5 - Slightly agree',
    '6 - Agree',
    '7 - Strongly agree'
  ];
  const BOOSTER_OPTIONS = ['1', '2', '3', '4', '5', '6', '7'];

  let jsPsychInstance = null;
  let participantId = '';
  let experimentExitReason = 'completed';
  let stimuliRows = [];
  let experimentPlan = null;
  let experimentStarted = false;
  let stimuliLoaded = false;
  let methodMaskMap = {};
  let finalScreenRendered = false;
  let lastQuizPassed = false;

  const experimentEl = document.getElementById('experiment');
  const loadingEl = document.getElementById('loading-screen');
  const guardEl = document.getElementById('viewport-guard');
  const quitEl = document.getElementById('quit-container');
  const quitButton = document.getElementById('quit-button');
  const modalEl = document.getElementById('zoom-modal');
  const modalImageEl = document.getElementById('modal-image');
  const modalCloseEl = document.getElementById('modal-close');

  function isMobile() {
    return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  }

  function isViewportAllowed() {
    return window.innerWidth >= MIN_VIEWPORT_WIDTH && !isMobile();
  }

  function updateViewportGuard() {
    const allowed = isViewportAllowed();
    if (allowed) {
      guardEl.classList.add('hidden');
      if (stimuliLoaded && !experimentStarted) {
        startExperiment();
      }
    } else {
      guardEl.classList.remove('hidden');
    }
  }

  function openModal(src) {
    if (!src) {
      return;
    }
    modalImageEl.setAttribute('src', src);
    modalEl.classList.remove('hidden');
  }

  function closeModal() {
    modalImageEl.removeAttribute('src');
    modalEl.classList.add('hidden');
  }

  function setupZoomHandlers(scope = document) {
    const targets = scope.querySelectorAll('[data-zoom-src]');
    targets.forEach((target) => {
      target.addEventListener('click', (event) => {
        event.preventDefault();
        openModal(target.getAttribute('data-zoom-src'));
      });
    });
  }

  function sanitizeForHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function interpretBoolean(value) {
    if (typeof value === 'boolean') {
      return value;
    }
    if (value === undefined || value === null) {
      return false;
    }
    const normalized = String(value).trim().toLowerCase();
    return ['1', 'true', 'yes', 'y'].includes(normalized);
  }

  function seededShuffle(list, seedInput) {
    const result = list.slice();
    if (result.length <= 1) {
      return result;
    }
    let seed = cyrb53(`${seedInput}::seed`);
    for (let i = result.length - 1; i > 0; i--) {
      seed = cyrb53(`${seedInput}:${seed}:${i}`);
      const j = seed % (i + 1);
      const temp = result[i];
      result[i] = result[j];
      result[j] = temp;
    }
    return result;
  }

  function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 =
      Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
      Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 =
      Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
      Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  function chooseVariantForParticipant(pid, identityId, methodName, variants) {
    if (!Array.isArray(variants) || variants.length === 0) {
      return null;
    }
    if (variants.length === 1) {
      return variants[0];
    }
    const hash = cyrb53(`${pid}|${identityId}|${methodName}`);
    const index = hash % variants.length;
    return variants[index];
  }

  async function loadStimuli() {
    const response = await fetch('stimuli.csv', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Unable to load stimuli.csv (HTTP ${response.status})`);
    }
    const text = await response.text();
    return parseCsv(text);
  }

  function parseCsv(text) {
    const result = [];
    const cleaned = text.replace(/^[\uFEFF]/, '');
    if (!cleaned.trim()) {
      return result;
    }
    const rows = [];
    let buffer = '';
    let insideQuotes = false;
    const normalized = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized[i];
      const next = normalized[i + 1];
      if (char === '"' && next === '"') {
        buffer += '""';
        i += 1;
        continue;
      }
      if (char === '"') {
        insideQuotes = !insideQuotes;
        buffer += char;
        continue;
      }
      if (char === '\n' && !insideQuotes) {
        rows.push(buffer);
        buffer = '';
      } else {
        buffer += char;
      }
    }
    if (buffer.length > 0) {
      rows.push(buffer);
    }
    if (!rows.length) {
      return result;
    }
    const headerLine = rows.shift();
    if (!headerLine) {
      return result;
    }
    const headers = splitCsvLine(headerLine);
    rows.forEach((line) => {
      if (!line.trim()) {
        return;
      }
      const values = splitCsvLine(line);
      const record = {};
      headers.forEach((header, index) => {
        record[header] = values[index] !== undefined ? values[index] : '';
      });
      result.push(record);
    });
    return result;
  }

  function splitCsvLine(line) {
    const cells = [];
    let current = '';
    let insideQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
        continue;
      }
      if (char === '"') {
        insideQuotes = !insideQuotes;
        continue;
      }
      if (char === ',' && !insideQuotes) {
        cells.push(current.trim());
        current = '';
        continue;
      }
      current += char;
    }
    cells.push(current.trim());
    return cells;
  }

  function prepareExperimentPlan(rows) {
    const methodSet = new Set();
    const trainingRows = [];
    const attentionRows = {
      instructional: [],
      obvious: {}
    };
    const identities = new Map();

    rows.forEach((row) => {
      const identityId = (row.identity_id || '').trim();
      const method = (row.method || '').trim();
      const phase = (row.phase || row.block || '').trim().toLowerCase();
      const attentionType = (row.attention_type || '').trim().toLowerCase();
      const attentionGroup = (row.attention_group || '').trim();

      if (attentionType === 'instructional') {
        attentionRows.instructional.push(row);
        return;
      }
      if (attentionType === 'obvious_pair') {
        const key =
          attentionGroup ||
          identityId ||
          `obvious_${Object.keys(attentionRows.obvious).length}`;
        if (!attentionRows.obvious[key]) {
          attentionRows.obvious[key] = [];
        }
        attentionRows.obvious[key].push(row);
        return;
      }
      if (phase === 'practice' || phase === 'training') {
        trainingRows.push(row);
        return;
      }
      if (identityId && method) {
        methodSet.add(method);
        if (!identities.has(identityId)) {
          identities.set(identityId, []);
        }
        identities.get(identityId).push(row);
      }
    });

    return {
      methodNames: Array.from(methodSet),
      identities: Array.from(identities.entries()).map(([identityId, rowsForIdentity]) => ({
        identity_id: identityId,
        rows: rowsForIdentity
      })),
      trainingRows,
      attentionRows
    };
  }
  function assignMethodMasks(methodNames, seedKey) {
    if (!methodNames.length) {
      return {};
    }
    const available = METHOD_LABELS.slice(0, Math.max(methodNames.length, 4));
    const shuffled = seededShuffle(available, `${seedKey}|methodMask`);
    const maskMap = {};
    methodNames.forEach((methodName, index) => {
      maskMap[methodName] = shuffled[index] || shuffled[index % shuffled.length];
    });
    return maskMap;
  }

  function prepareParticipantTimeline(plan, pid, maskMap) {
    const identityStimuli = plan.identities
      .map((identity) => {
        const methodMap = new Map();
        identity.rows.forEach((row) => {
          const methodName = (row.method || '').trim();
          const imageUrl = (row.image_url || '').trim();
          if (!methodName || !imageUrl) {
            return;
          }
          if (!methodMap.has(methodName)) {
            methodMap.set(methodName, []);
          }
          methodMap.get(methodName).push(row);
        });
        const methods = [];
        methodMap.forEach((variants, methodName) => {
          const chosen = chooseVariantForParticipant(
            pid,
            identity.identity_id,
            methodName,
            variants
          );
          if (!chosen || !(chosen.image_url || '').trim()) {
            return;
          }
          methods.push({
            identity_id: identity.identity_id,
            identity_display: chosen.identity_label || identity.identity_id,
            method_true: methodName,
            method_mask: maskMap[methodName] || '?',
            variant: chosen.variant || '',
            image_url: chosen.image_url,
            thumb_url: chosen.thumb_url || chosen.image_url,
            reference_url: chosen.ref_url || chosen.reference_url || chosen.reference_image || '',
            metadata: chosen
          });
        });
        if (!methods.length) {
          return null;
        }
        return {
          identity_id: identity.identity_id,
          identity_display:
            identity.rows[0]?.identity_label ||
            identity.identity_id,
          trials: seededShuffle(
            methods,
            `${pid}|${identity.identity_id}|methods`
          )
        };
      })
      .filter(Boolean);

    const trainingStimuli = plan.trainingRows.length
      ? plan.trainingRows
          .filter((row) => (row.image_url || '').trim())
          .map((row, index) => ({
            identity_id: row.identity_id || `practice_${index + 1}`,
            identity_display: row.identity_label || 'Practice Identity',
            method_true: row.method || `Practice ${index + 1}`,
            method_mask: maskMap[row.method] || `Demo ${index + 1}`,
            variant: row.variant || '',
            image_url: row.image_url,
            thumb_url: row.thumb_url || row.image_url,
            reference_url: row.ref_url || row.reference_url || row.reference_image || row.image_url,
            metadata: row
          }))
      : getDefaultPracticeStimuli();

    const attention = buildAttentionConfig(plan.attentionRows, maskMap, pid);

    const preloadImages = new Set();
    identityStimuli.forEach((identity) => {
      identity.trials.forEach((trial) => {
        if (trial.thumb_url) {
          preloadImages.add(trial.thumb_url);
        }
        if (trial.image_url) {
          preloadImages.add(trial.image_url);
        }
      });
    });
    trainingStimuli.forEach((trial) => {
      if (trial.thumb_url) {
        preloadImages.add(trial.thumb_url);
      }
      if (trial.image_url) {
        preloadImages.add(trial.image_url);
      }
    });
    if (attention.obviousPair) {
      if (attention.obviousPair.left.image_url) {
        preloadImages.add(attention.obviousPair.left.image_url);
      }
      if (attention.obviousPair.right.image_url) {
        preloadImages.add(attention.obviousPair.right.image_url);
      }
    }

    return {
      identityStimuli,
      trainingStimuli,
      attention,
      preloadImages: Array.from(preloadImages).filter(Boolean)
    };
  }

  function buildAttentionConfig(attentionRows, maskMap, pid) {
    const config = {
      instructional: null,
      obviousPair: null
    };

    if (attentionRows.instructional.length) {
      const first = attentionRows.instructional[0];
      config.instructional = {
        prompt:
          first.attention_prompt ||
          'Instructional attention check: Please select 6 to confirm you are reading carefully.'
      };
    } else {
      config.instructional = {
        prompt: 'Instructional attention check: Please select 6 to confirm you are reading carefully.'
      };
    }

    const groups = attentionRows.obvious || {};
    const groupKeys = Object.keys(groups);
    let chosenGroup = null;
    for (let i = 0; i < groupKeys.length; i++) {
      const key = groupKeys[i];
      if (groups[key].length >= 2) {
        chosenGroup = groups[key];
        break;
      }
    }
    if (chosenGroup) {
      const shuffled = seededShuffle(
        chosenGroup,
        `${pid}|attention_pair`
      );
      const [first, second] = shuffled;
      const left = mapAttentionStimulus(first, maskMap);
      const right = mapAttentionStimulus(second || first, maskMap);
      config.obviousPair = {
        prompt:
          first.attention_prompt ||
          'Which caricature looks more plausible for the attention check?',
        identity_id: first.identity_id || 'obvious_pair',
        left,
        right,
        correct: interpretBoolean(first.attention_correct)
          ? 'left'
          : interpretBoolean(second?.attention_correct)
          ? 'right'
          : 'left'
      };
    } else {
      config.obviousPair = getDefaultObviousPair(maskMap);
    }
    return config;
  }

  function mapAttentionStimulus(row, maskMap) {
    const methodName = (row.method || '').trim();
    return {
      image_url: row.image_url || '',
      thumb_url: row.thumb_url || row.image_url || '',
      method_true: methodName || 'Unknown',
      method_mask: maskMap[methodName] || '—',
      variant: row.variant || '',
      metadata: row
    };
  }

  function getDefaultPracticeStimuli() {
    const baseClean =
      'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="720" viewBox="0 0 600 720"><defs><linearGradient id="a" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#99b9ff"/><stop offset="100%" stop-color="#3d6ad6"/></linearGradient></defs><rect width="600" height="720" fill="url(#a)"/><circle cx="300" cy="240" r="120" fill="#ffd6c8"/><path d="M260 220c0 30 80 30 80 0" stroke="#c04b3f" stroke-width="12" stroke-linecap="round" fill="none"/><path d="M242 300q58 70 116 0" stroke="#0f1c3c" stroke-width="16" stroke-linecap="round" fill="none"/><circle cx="255" cy="220" r="18" fill="#0f1c3c"/><circle cx="345" cy="220" r="18" fill="#0f1c3c"/><rect x="160" y="420" width="280" height="200" rx="36" fill="#fff" opacity="0.76"/><text x="300" y="545" font-family="Segoe UI, Arial" font-size="42" fill="#1f4f9c" text-anchor="middle">Practice Caricature</text></svg>'
      );
    const baseStylized =
      'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="720" viewBox="0 0 600 720"><rect width="600" height="720" fill="#0f1c3c"/><path d="M130 640l160-520 180 520" fill="#ff9f1c" opacity="0.8"/><path d="M190 520c0-120 220-120 220 0" stroke="#ffbf69" stroke-width="18" fill="none"/><circle cx="240" cy="260" r="48" fill="#ffbf69"/><circle cx="360" cy="260" r="48" fill="#ffbf69"/><path d="M220 420q80 68 160 0" stroke="#f75c03" stroke-width="20" stroke-linecap="round" fill="none"/><text x="300" y="120" font-family="Segoe UI, Arial" font-size="46" fill="#ffffff" text-anchor="middle">Stylized Demo</text><text x="300" y="172" font-family="Segoe UI, Arial" font-size="24" fill="#a6b8ff" text-anchor="middle">Practice Image</text></svg>'
      );
    return [
      {
        identity_id: 'practice_demo',
        identity_display: 'Practice Identity',
        method_true: 'Practice Reference',
        method_mask: 'Demo',
        variant: 'practice-clean',
        image_url: baseClean,
        thumb_url: baseClean,
        reference_url: baseClean,
        metadata: { origin: 'generated-placeholder' }
      },
      {
        identity_id: 'practice_demo',
        identity_display: 'Practice Identity',
        method_true: 'Practice Stylized',
        method_mask: 'Demo',
        variant: 'practice-stylized',
        image_url: baseStylized,
        thumb_url: baseStylized,
        reference_url: baseClean,
        metadata: { origin: 'generated-placeholder' }
      }
    ];
  }

  function getDefaultObviousPair(maskMap) {
    const clean =
      'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="720" viewBox="0 0 600 720"><rect width="600" height="720" fill="#f8fbff"/><circle cx="300" cy="260" r="150" fill="#ffe2d2"/><rect x="210" y="420" width="180" height="150" rx="30" fill="#1f4f9c" opacity="0.18"/><circle cx="260" cy="240" r="28" fill="#0d1f3c"/><circle cx="340" cy="240" r="28" fill="#0d1f3c"/><path d="M240 320q60 48 120 0" stroke="#e56633" stroke-width="18" stroke-linecap="round" fill="none"/><text x="300" y="560" font-family="Segoe UI, Arial" font-size="40" fill="#1f4f9c" text-anchor="middle">Clean Reference</text></svg>'
      );
    const corrupted =
      'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="720" viewBox="0 0 600 720"><defs><filter id="glitch"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="50"/></filter></defs><rect width="600" height="720" fill="#010b1c"/><rect x="40" y="40" width="520" height="640" rx="38" fill="#8c1932" filter="url(#glitch)"/><text x="300" y="360" font-family="Segoe UI, Arial" font-size="46" fill="#ffe06c" text-anchor="middle">Corrupted</text><text x="300" y="410" font-family="Segoe UI, Arial" font-size="24" fill="#ffe06c" text-anchor="middle">Attention Check</text></svg>'
      );
    return {
      prompt: 'Attention check: One of these caricatures has been deliberately corrupted. Select the plausible image.',
      identity_id: 'attention_default',
      left: {
        image_url: clean,
        thumb_url: clean,
        method_true: 'Default Clean',
        method_mask: maskMap['Default Clean'] || 'CLEAN',
        variant: 'attention-clean',
        metadata: { origin: 'default-attention' }
      },
      right: {
        image_url: corrupted,
        thumb_url: corrupted,
        method_true: 'Default Corrupted',
        method_mask: maskMap['Default Corrupted'] || 'GLITCH',
        variant: 'attention-corrupted',
        metadata: { origin: 'default-attention' }
      },
      correct: 'left'
    };
  }
  function startExperiment() {
    if (experimentStarted) {
      return;
    }
    experimentStarted = true;

    jsPsychInstance = jsPsychModule.initJsPsych({
      display_element: 'experiment',
      show_progress_bar: false,
      on_trial_finish: (data) => {
        data.participant_id = participantId || data.participant_id || '';
        data.end_timestamp = new Date().toISOString();
      },
      on_finish: () => finalizeExperiment(experimentExitReason)
    });

    const initialTimeline = buildInitialTimeline();
    jsPsychInstance.run(initialTimeline);
    loadingEl.classList.add('hidden');
  }

  function buildInitialTimeline() {
    const timeline = [];

        timeline.push({
          type: jsPsychInstructions,
          pages: [
            `
              <div class="panel">
                <h1>Caricature Comparison Study</h1>
                <p>Welcome! In this study you will evaluate sets of caricatures, answer comparative questions, and complete a short demographics form.</p>
                <ul>
                  <li>Ensure you are on a desktop or laptop with a viewport at least 1024&nbsp;px wide.</li>
                  <li>All caricature images are preloaded to avoid lag; allow a few seconds for the initial load.</li>
                  <li>You can zoom any image by clicking on it or using the zoom button.</li>
                  <li>The “Quit Study” button remains available if you need to discontinue at any time.</li>
                </ul>
                <p>Click “Begin” to review the consent form.</p>
              </div>
            `
          ],
          show_clickable_nav: true,
          allow_backward: false,
          button_label_next: 'Begin',
          button_label_finish: 'Begin',
          data: { trial_category: 'welcome' }
        });

    timeline.push({
      type: jsPsychInstructions,
      pages: [
        `
          <div class="panel">
            <h2>Consent</h2>
            <p>You are invited to take part in a research study about caricature perception. Your participation is voluntary, and you may withdraw at any time by using the quit button or closing the window.</p>
            <p>By proceeding, you acknowledge that your anonymized responses may be used for research purposes. No personally identifying information is collected apart from an ID that you provide.</p>
          </div>
        `
      ],
      show_clickable_nav: true,
      button_label_next: 'I Consent',
      allow_backward: false,
      data: { trial_category: 'consent' },
      on_finish: (data) => {
        data.consent_given = true;
      }
    });

    timeline.push({
      type: jsPsychSurveyHtmlForm,
      html: `
        <div class="panel">
          <h2>Participant Details</h2>
          <p class="panel__meta">Provide a participant ID so your session can be matched with future data. Use the same ID across sessions if you expect to take part again.</p>
          <label for="participant-id">
            Participant ID (letters, numbers, dashes and underscores only)
          </label>
          <input id="participant-id" name="participant_id" type="text" pattern="[A-Za-z0-9_\-]{3,64}" required placeholder="e.g., P001_A" autocomplete="off" />
          <p class="panel__meta">Optional: include a prompt variant code (e.g., “A” or “B”) in your ID if you are balancing manually.</p>
        </div>
      `,
      button_label: 'Continue',
      data: { trial_category: 'participant_info' },
      on_finish: (data) => {
        participantId = (data.response?.participant_id || '').trim();
        if (!participantId) {
          participantId = `anon_${Date.now()}`;
        }
        methodMaskMap = assignMethodMasks(experimentPlan.methodNames, participantId);
        const participantPlan = prepareParticipantTimeline(
          experimentPlan,
          participantId,
          methodMaskMap
        );
        const mainTimeline = buildMainTimelineForParticipant(participantPlan);
        jsPsychInstance.addNodeToEndOfTimeline(
          { timeline: mainTimeline },
          () => {
            quitEl.classList.remove('hidden');
          }
        );
      }
    });

    return timeline;
  }

  function buildMainTimelineForParticipant(plan) {
    const timeline = [];

    const totalCaricatureTrials =
      (plan.trainingStimuli?.length || 0) +
      plan.identityStimuli.reduce(
        (sum, identity) => sum + (identity.trials?.length || 0),
        0
      );
    let progressCounter = 0;
    const getNextProgress =
      totalCaricatureTrials > 0
        ? () => {
            progressCounter += 1;
            return {
              index: progressCounter,
              total: totalCaricatureTrials
            };
          }
        : null;

    if (plan.preloadImages.length) {
      timeline.push({
        type: jsPsychPreload,
        auto_preload: false,
        images: plan.preloadImages,
        message: 'Preloading caricature images…',
        error_message: `
          <div class="panel">
            <h2>Image Loading Warning</h2>
            <p>One or more caricature images failed to preload. You may continue, but some trials could show placeholders.</p>
          </div>
        `,
        continue_after_error: true,
        data: { trial_category: 'preload' }
      });
    }

    timeline.push(...buildTrainingBlock(plan.trainingStimuli, getNextProgress));
    timeline.push(buildComprehensionCheckBlock());

    const attentionTrials = [];
    if (plan.attention.instructional) {
      attentionTrials.push(createInstructionalAttentionTrial(plan.attention.instructional));
    }
    if (plan.attention.obviousPair) {
      attentionTrials.push(createObviousPairTrial(plan.attention.obviousPair));
    }

    const identityBlocks = plan.identityStimuli.map((identity) =>
      createIdentityTimeline(identity, getNextProgress)
    );

    if (identityBlocks.length) {
      const attentionQueue = attentionTrials.slice();
      identityBlocks.forEach((block, index) => {
        timeline.push(...block);
        if (attentionQueue.length && index === 0) {
          timeline.push(attentionQueue.shift());
        } else if (
          attentionQueue.length &&
          index === Math.floor(identityBlocks.length / 2)
        ) {
          timeline.push(attentionQueue.shift());
        }
      });
      attentionQueue.forEach((trial) => {
        timeline.push(trial);
      });
    } else {
      attentionTrials.forEach((trial) => timeline.push(trial));
    }

    timeline.push(buildDemographicsTrial());
    timeline.push(buildDebriefTrial());
    timeline.push(buildExportPromptTrial());

    return timeline;
  }

  function buildTrainingBlock(trainingStimuli, getNextProgress) {
    const timeline = [];

    timeline.push({
      type: jsPsychInstructions,
      pages: [
        `
          <div class="panel">
            <h2>How the study works</h2>
            <p>You will review sets of caricatures for the same individual. For each caricature, you'll use sliders to rate five key aspects:</p>
            <ul>
              <li><strong>Identity</strong> (1-7): How much does this caricature still look like the same person as the reference photo?</li>
              <li><strong>Exaggeration</strong> (1-7): How strong is the exaggeration of facial features in this caricature?</li>
              <li><strong>Alignment</strong> (1-7): Does this caricature exaggerate the right features that make this person distinctive?</li>
              <li><strong>Plausibility</strong> (1-7): Is the caricature visually and anatomically plausible (natural, coherent, not distorted)?</li>
              <li><strong>Overall</strong> (0-100): Considering everything, how good is this caricature overall?</li>
            </ul>
            <p>After rating all caricatures in a set, you will answer comparative questions and complete a forced rank ordering.</p>
          </div>
        `,
        `
          <div class="panel">
            <h2>Controls &amp; attention checks</h2>
            <ul>
              <li>Click an image or the “Zoom” button to view it full size.</li>
              <li>All required questions must be answered before you can continue.</li>
              <li>Two attention checks are included: one instructional (“Select 6…”) and one plausibility check with an obviously corrupted image.</li>
              <li>Use consistent judgement criteria across the whole study.</li>
            </ul>
            <p>Let’s run a quick practice so you can see the interface.</p>
          </div>
        `
      ],
      show_clickable_nav: true,
      allow_backward: true,
      button_label_previous: 'Back',
      button_label_next: 'Next',
      button_label_finish: 'Start practice',
      data: { trial_category: 'instructions' }
    });

    trainingStimuli.forEach((stimulus, index) => {
      const progressInfo = getNextProgress ? getNextProgress() : null;
      timeline.push(
        createCaricatureSurveyTrial(stimulus, {
          isPractice: true,
          sequenceIndex: index + 1,
          totalCount: trainingStimuli.length,
          progressIndex: progressInfo?.index,
          progressTotal: progressInfo?.total
        })
      );
    });

    timeline.push({
      type: jsPsychHtmlButtonResponse,
      stimulus: `
        <div class="panel">
          <h2>Practice complete</h2>
          <p>You’re ready for the main trials. Remember, all required items must be answered before you can continue.</p>
          <p>Click “Proceed” to begin the main study timeline.</p>
        </div>
      `,
      choices: ['Proceed'],
      data: { trial_category: 'post_practice' }
    });

    return timeline;
  }
  function createCaricatureSurveyTrial(stimulus, options = {}) {
    const isPractice = Boolean(options.isPractice);
    const identityLabel = sanitizeForHtml(stimulus.identity_display || stimulus.identity_id);
    const methodMaskLabel = sanitizeForHtml(stimulus.method_mask || '?');
    const variantIndex = options.sequenceIndex || 1;
    const variantDescriptor = options.totalCount
      ? `Variant ${variantIndex}/${options.totalCount}`
      : '';
    const cardLabelPrefix = isPractice ? 'Practice Caricature' : 'Caricature';
    const cardLabelParts = [];
    // Hide method labels from user display
    // if (methodMaskLabel) {
    //   cardLabelParts.push(`Method ${methodMaskLabel}`);
    // }
    if (variantDescriptor) {
      cardLabelParts.push(variantDescriptor);
    }
    const primaryCardLabel = `${cardLabelPrefix}${cardLabelParts.length ? ` (${cardLabelParts.join(' &ndash; ')})` : ''}`;
    const progressIndex = Number(options.progressIndex) || 0;
    const progressTotal = Number(options.progressTotal) || 0;
    const progressLabel =
      progressIndex > 0 && progressTotal > 0
        ? `Image ${progressIndex} of ${progressTotal}`
        : '';

    const buildSliderQuestion = (name, prompt, min, max, step, leftLabel, rightLabel, required, middleLabel = null) => {
      const sanitizedName = sanitizeForHtml(name);
      const sliderId = `${sanitizedName}_slider`;
      const valueId = `${sanitizedName}_value`;
      const requiredAttr = required ? 'required' : '';
      
      // Special handling for overall question with three anchors
      const labelsHtml = middleLabel 
        ? `
          <div class="slider-labels">
            <span>${sanitizeForHtml(leftLabel)}</span>
            <span>${sanitizeForHtml(middleLabel)}</span>
            <span>${sanitizeForHtml(rightLabel)}</span>
          </div>
        `
        : `
          <div class="slider-labels">
            <span>${sanitizeForHtml(leftLabel)}</span>
            <span>${sanitizeForHtml(rightLabel)}</span>
          </div>
        `;
      
      return `
        <div class="question-block">
          <p class="question-prompt">${sanitizeForHtml(prompt)}</p>
          <div class="slider-wrapper">
            <input
              type="range"
              id="${sliderId}"
              name="${sanitizedName}"
              min="${min}"
              max="${max}"
              step="${step}"
              value="${Math.floor((min + max) / 2)}"
              ${requiredAttr}
              aria-describedby="${valueId}"
            >
            <div class="slider-value" id="${valueId}">${Math.floor((min + max) / 2)}</div>
            ${labelsHtml}
          </div>
        </div>
      `;
    };

    const identityQuestion = buildSliderQuestion(
      'identity',
      'How much does this caricature still look like the same person as the reference photo?',
      1, 7, 1,
      'Not at all the same person',
      'Clearly the same person',
      true
    );
    
    const exaggerationQuestion = buildSliderQuestion(
      'exaggeration',
      'How strong is the exaggeration of facial features in this caricature?',
      1, 7, 1,
      'No exaggeration',
      'Very strong exaggeration',
      true
    );
    
    const alignmentQuestion = buildSliderQuestion(
      'alignment',
      'Does this caricature exaggerate the right features that make this person distinctive?',
      1, 7, 1,
      'Exaggerates irrelevant/wrong features',
      'Exaggerates exactly the distinctive traits',
      true
    );
    
    const plausibilityQuestion = buildSliderQuestion(
      'plausibility',
      'Is the caricature visually and anatomically plausible (natural, coherent, not distorted)?',
      1, 7, 1,
      'Very implausible / distorted',
      'Fully plausible and natural-looking',
      true
    );
    
    const overallQuestion = buildSliderQuestion(
      'overall',
      'Considering everything (identity, exaggeration, alignment, and plausibility), how good is this caricature overall?',
      0, 100, 1,
      'Very poor',
      'Outstanding',
      true,
      'Average'
    );

    const primaryImageSrc = sanitizeForHtml(stimulus.thumb_url || stimulus.image_url);
    const primaryZoomSrc = sanitizeForHtml(stimulus.image_url);
    const referenceUrl = sanitizeForHtml(
      stimulus.reference_url ||
        stimulus.metadata?.ref_url ||
        stimulus.metadata?.reference_url ||
        ''
    );
    const referenceLabel = sanitizeForHtml(
      stimulus.metadata?.reference_label ||
        (isPractice ? 'Practice reference' : 'Reference image')
    );
    const variantTag = sanitizeForHtml(stimulus.variant || '');
    const sanitizedProgressLabel = progressLabel ? sanitizeForHtml(progressLabel) : '';
    const progressHtml =
      sanitizedProgressLabel
        ? `<div class="trial-progress" aria-live="polite">${sanitizedProgressLabel}</div>`
        : '';
    const referenceSection = referenceUrl
      ? `
        <div class="stimulus-card reference-card">
          <div class="stimulus-card__meta">
            <span>${referenceLabel}</span>
            <span></span>
          </div>
          <div class="stimulus-card__image">
            <img src="${referenceUrl}"
                 data-zoom-src="${referenceUrl}"
                 alt="Reference image"
                 class="stimulus-card__img stimulus-card__img--reference" />
            <button type="button" class="zoom-trigger" data-zoom-src="${referenceUrl}">Zoom reference</button>
          </div>
        </div>
      `
      : '';

    const html = `
      <div class="panel">
        ${progressHtml}
        <div class="panel__meta">
          ${isPractice ? 'Practice trial' : `Identity: ${identityLabel}`} &middot; <span style="display: none;">Method ${methodMaskLabel}</span>
        </div>
        <div class="stimulus-comparison">
          <div class="stimulus-card stimulus-card--primary" style="position: relative;">
            <div class="zoom-icon" data-zoom-src="${primaryZoomSrc}" title="Zoom caricature"></div>
            <div class="stimulus-card__meta">
              <span>${primaryCardLabel}</span>
              <span>${variantTag || ''}</span>
            </div>
            <div class="stimulus-card__image">
              <img src="${primaryImageSrc}"
                   data-zoom-src="${primaryZoomSrc}"
                   alt="Caricature image preview"
                   class="stimulus-card__img" />
            </div>
          </div>
          ${referenceSection}
        </div>
        <p>Please answer the required questions below${isPractice ? ' (practice responses are not saved).' : '.'}</p>
        <div class="question-stack">
          ${identityQuestion}
          ${exaggerationQuestion}
          ${alignmentQuestion}
          ${plausibilityQuestion}
          ${overallQuestion}
        </div>
      </div>
    `;
    return {
      type: jsPsychSurveyHtmlForm,
      html,
      button_label: isPractice ? 'Continue' : 'Next caricature →',
      data: {
        trial_category: isPractice ? 'caricature_practice' : 'caricature_rating',
        identity_id: stimulus.identity_id,
        identity_display: stimulus.identity_display,
        method_true: stimulus.method_true,
        method_mask: stimulus.method_mask,
        variant: stimulus.variant,
        is_practice: isPractice,
        participant_id: participantId
      },
      on_load: () => {
        const formRoot = document.getElementById('jspsych-survey-html-form');
        setupZoomHandlers(formRoot || document);
        
        // Setup all sliders with dynamic value updates
        const sliders = formRoot?.querySelectorAll('input[type="range"]') || [];
        const submitButton = formRoot?.querySelector('button[type="submit"]');
        
        sliders.forEach(slider => {
          const valueDisplay = formRoot?.querySelector(`#${slider.id.replace('_slider', '_value')}`);
          if (valueDisplay) {
            valueDisplay.textContent = slider.value;
            
            // Special handling for overall slider with color gradient
            if (slider.name === 'overall') {
              updateOverallSliderColor(slider);
            }
            
            slider.addEventListener('input', () => {
              valueDisplay.textContent = slider.value;
              
              // Update color for overall slider
              if (slider.name === 'overall') {
                updateOverallSliderColor(slider);
              }
              
              checkAllSlidersMoved();
            });
          }
        });
        
        function updateOverallSliderColor(slider) {
          const value = parseInt(slider.value);
          const percentage = value / 100;
          
          // Calculate color based on value (red to green)
          let red, green, blue;
          if (percentage <= 0.5) {
            // Red to yellow transition
            red = 255;
            green = Math.round(255 * percentage * 2);
            blue = 0;
          } else {
            // Yellow to green transition
            red = Math.round(255 * (1 - (percentage - 0.5) * 2));
            green = 255;
            blue = 0;
          }
          
          const color = `rgb(${red}, ${green}, ${blue})`;
          
          // Ensure the gradient background is maintained
          slider.style.background = `linear-gradient(to right, #ff4444 0%, #ffaa44 25%, #ffff44 50%, #aaff44 75%, #44ff44 100%)`;
          
          // Update the slider thumb color to match the current position
          slider.style.setProperty('--thumb-color', color);
        }
        
        function checkAllSlidersMoved() {
          if (!submitButton) return;
          
          const allSliders = formRoot?.querySelectorAll('input[type="range"]') || [];
          const allMoved = Array.from(allSliders).every(slider => {
            const defaultValue = Math.floor((parseInt(slider.min) + parseInt(slider.max)) / 2);
            return slider.value != defaultValue;
          });
          
          if (allMoved) {
            submitButton.disabled = false;
            submitButton.classList.remove('disabled');
          } else {
            submitButton.disabled = true;
            submitButton.classList.add('disabled');
          }
        }
        
        // Initially disable the button
        if (submitButton) {
          submitButton.disabled = true;
          submitButton.classList.add('disabled');
        }
      },
      on_finish: (data) => {
        const response = data.response || {};
        data.identity = response.identity !== undefined ? Number(response.identity) : null;
        data.exaggeration = response.exaggeration !== undefined ? Number(response.exaggeration) : null;
        data.alignment = response.alignment !== undefined ? Number(response.alignment) : null;
        data.plausibility = response.plausibility !== undefined ? Number(response.plausibility) : null;
        data.overall = response.overall !== undefined ? Number(response.overall) : null;
        data.reference_url =
          stimulus.reference_url ||
          stimulus.metadata?.ref_url ||
          stimulus.metadata?.reference_url ||
          '';
        data.metadata = stimulus.metadata || {};
      }
    };
  }

  function buildComprehensionCheckBlock() {
    lastQuizPassed = false;
    return {
      timeline: [
        {
          type: jsPsychSurveyMultiChoice,
          preamble: `
            <div class="panel">
              <h2>Comprehension Check</h2>
              <p>Answer these questions to confirm you understand the instructions. You will need to retry if any answer is incorrect.</p>
            </div>
          `,
          questions: [
            {
              prompt: 'What should you do when you need to inspect a caricature more closely?',
              name: 'zoom_usage',
              options: [
                'Skip the image and move on',
                'Use the zoom button or click the image to enlarge it',
                'Reload the entire page'
              ],
              required: true
            },
            {
              prompt: 'Instructional attention check: Select 6 here if you are reading carefully.',
              name: 'instructional_check',
              options: ['1', '2', '3', '4', '5', '6', '7'],
              required: true
            }
          ],
          randomize_question_order: false,
          data: { trial_category: 'comprehension_quiz' },
          on_finish: (data) => {
            // Debug logging
            console.log('Full data object:', data);
            console.log('Data keys:', Object.keys(data));
            
            // Try multiple possible response locations
            const response = data.response || data.responses || data;
            console.log('Response object:', response);
            console.log('Response keys:', Object.keys(response));
            
            // Check all possible locations for the responses
            const zoomResponse = response.zoom_usage || data.zoom_usage || '';
            const attentionResponse = response.instructional_check || data.instructional_check || '';
            
            console.log('Zoom usage response:', zoomResponse);
            console.log('Instructional check response:', attentionResponse);
            console.log('Zoom response type:', typeof zoomResponse);
            console.log('Attention response type:', typeof attentionResponse);
            
            // More flexible comparison
            const zoomOk = String(zoomResponse).trim() === 'Use the zoom button or click the image to enlarge it';
            const attentionOk = String(attentionResponse).trim() === '6';
            
            console.log('Zoom comparison:', String(zoomResponse).trim(), '===', 'Use the zoom button or click the image to enlarge it');
            console.log('Attention comparison:', String(attentionResponse).trim(), '===', '6');
            console.log('Zoom OK:', zoomOk);
            console.log('Attention OK:', attentionOk);
            
            lastQuizPassed = zoomOk && attentionOk;
            data.pass = lastQuizPassed;
            
            console.log('Quiz passed:', lastQuizPassed);
            
            // If still failing, let's try a more lenient approach
            if (!lastQuizPassed) {
              console.log('Trying lenient comparison...');
              const zoomLenient = String(zoomResponse).toLowerCase().includes('zoom') && 
                                 String(zoomResponse).toLowerCase().includes('enlarge');
              const attentionLenient = String(attentionResponse) === '6';
              
              console.log('Lenient zoom OK:', zoomLenient);
              console.log('Lenient attention OK:', attentionLenient);
              
              if (zoomLenient && attentionLenient) {
                console.log('Using lenient comparison - quiz passed');
                lastQuizPassed = true;
                data.pass = true;
              }
            }
          }
        },
        {
          type: jsPsychHtmlButtonResponse,
          stimulus: `
            <div class="panel">
              <h2>Let's double-check</h2>
              <p>You missed at least one comprehension question. Please review the instructions shown earlier and try again.</p>
            </div>
          `,
          choices: ['Review and retry'],
          conditional_function: () => {
            let passed = lastQuizPassed === true;
            if (!passed) {
              const previousTrial = jsPsychInstance.data
                .get()
                .filter({ trial_category: 'comprehension_quiz' })
                .values()
                .slice(-1)[0];
              const storedPass =
                previousTrial?.pass === true ||
                previousTrial?.pass === 'true' ||
                previousTrial?.pass === 1;
              console.log('Conditional function fallback - stored pass value:', previousTrial?.pass);
              if (storedPass) {
                lastQuizPassed = true;
                passed = true;
              }
            }
            console.log('Conditional function - lastQuizPassed:', passed);
            return !passed;
          },
          data: { trial_category: 'comprehension_feedback' }
        }
      ],
      loop_function: () => {
        let passed = lastQuizPassed === true;
        if (!passed) {
          const quizTrial = jsPsychInstance.data
            .get()
            .filter({ trial_category: 'comprehension_quiz' })
            .values()
            .slice(-1)[0];
          const storedPass =
            quizTrial?.pass === true || quizTrial?.pass === 'true' || quizTrial?.pass === 1;
          console.log('Loop function fallback - stored pass value:', quizTrial?.pass);
          if (storedPass) {
            lastQuizPassed = true;
            passed = true;
          }
        }
        console.log('Loop function - lastQuizPassed:', passed);
        return !passed;
      }
    };
  }

  function createIdentityTimeline(identity, getNextProgress) {
    const timeline = [];
    timeline.push({
      type: jsPsychHtmlButtonResponse,
      stimulus: `
        <div class="panel">
          <h2>${sanitizeForHtml(identity.identity_display || identity.identity_id)}</h2>
          <p>You will now rate ${identity.trials.length} caricature${identity.trials.length === 1 ? '' : 's'} for this identity.</p>
        </div>
      `,
      choices: ['Begin'],
      data: {
        trial_category: 'identity_intro',
        identity_id: identity.identity_id,
        identity_display: identity.identity_display
      }
    });

    identity.trials.forEach((trial, index) => {
      const progressInfo = getNextProgress ? getNextProgress() : null;
      timeline.push(
        createCaricatureSurveyTrial(trial, {
          isPractice: false,
          sequenceIndex: index + 1,
          totalCount: identity.trials.length,
          progressIndex: progressInfo?.index,
          progressTotal: progressInfo?.total
        })
      );
    });

    timeline.push(createComparativeChoicesTrial(identity));
    timeline.push(createForcedRankingTrial(identity));

    return timeline;
  }

  function createComparativeChoicesTrial(identity) {
    const attrSafe = (value) =>
      String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_');

    const questionConfigs = [
      {
        name: 'winner_likeness',
        prompt: 'Which caricature offered the best likeness?'
      },
      {
        name: 'winner_style',
        prompt: 'Which caricature showed the strongest artistic finish?'
      },
      {
        name: 'winner_expression',
        prompt: 'Which caricature felt most expressive?'
      },
      {
        name: 'winner_overall',
        prompt: 'Overall, which caricature was best?'
      }
    ];

    const optionMap = identity.trials.map((trial) => ({
      mask: trial.method_mask,
      method: trial.method_true,
      variant: trial.variant,
      image_url: trial.image_url,
      reference_url:
        trial.reference_url ||
        trial.metadata?.ref_url ||
        trial.metadata?.reference_url ||
        ''
    }));

    const methodCards = identity.trials.map((trial, index) => {
      const mask = sanitizeForHtml(trial.method_mask);
      const variant = sanitizeForHtml(trial.variant || '');
      const image = sanitizeForHtml(trial.thumb_url || trial.image_url);
      const zoom = sanitizeForHtml(trial.image_url);
      const cardId = attrSafe(`${mask}_${index}`);
      return {
        mask,
        variant,
        image,
        zoom,
        cardId,
        value: `Method ${mask}`
      };
    });

    const questionsHtml = questionConfigs
      .map((question) => {
        const cardsHtml = methodCards
          .map((card, index) => {
            const inputId = `${question.name}_${card.cardId}`;
            const requiredAttr = index === 0 ? 'required' : '';
            const variantMarkup = card.variant
              ? `<div class="comparison-card__variant">${card.variant}</div>`
              : '';
            return `
              <div class="comparison-card">
                <div class="comparison-card__image">
                  <img src="${card.image}"
                       data-zoom-src="${card.zoom}"
                       alt="Preview for Method ${card.mask}">
                </div>
                <div class="comparison-card__label" style="display: none;">Method ${card.mask}</div>
                <div style="display: none;">${variantMarkup}</div>
                <div>
                  <input type="radio"
                         id="${inputId}"
                         name="${question.name}"
                         value="${sanitizeForHtml(card.value)}"
                         ${requiredAttr}>
                  <label for="${inputId}">Select</label>
                </div>
              </div>
            `;
          })
          .join('');

        return `
          <fieldset class="comparison-section">
            <legend class="question-prompt">${sanitizeForHtml(question.prompt)}</legend>
            <div class="comparison-grid">
              ${cardsHtml}
            </div>
          </fieldset>
        `;
      })
      .join('');

    return {
      type: jsPsychSurveyHtmlForm,
      html: `
        <div class="panel comparator-panel">
          <h2>${sanitizeForHtml(identity.identity_display || identity.identity_id)} &middot; Comparative Judgements</h2>
          <p>Select the caricature that best fits each criterion. Images can be enlarged via the zoom control.</p>
          ${questionsHtml}
        </div>
      `,
      button_label: 'Submit selections',
      data: {
        trial_category: 'comparative_choices',
        identity_id: identity.identity_id,
        identity_display: identity.identity_display,
        option_map: optionMap,
        participant_id: participantId
      },
      on_load: () => {
        const formRoot = document.getElementById('jspsych-survey-html-form');
        setupZoomHandlers(formRoot || document);
      },
      on_finish: (data) => {
        const response = data.response || {};
        data.choices = response;
        data.winner_likeness = response.winner_likeness || '';
        data.winner_style = response.winner_style || '';
        data.winner_expression = response.winner_expression || '';
        data.winner_overall = response.winner_overall || '';
        const valueToMask = (value) => {
          if (!value) {
            return '';
          }
          const entry = optionMap.find((option) => {
            const raw = `Method ${option.mask}`;
            return raw === value || sanitizeForHtml(raw) === value;
          });
          return entry ? entry.mask : value;
        };
        data.winner_likeness_mask = valueToMask(response.winner_likeness);
        data.winner_style_mask = valueToMask(response.winner_style);
        data.winner_expression_mask = valueToMask(response.winner_expression);
        data.winner_overall_mask = valueToMask(response.winner_overall);
      }
    };
  }

  function createForcedRankingTrial(identity) {
    const encodeAttr = (value) =>
      encodeURIComponent(String(value ?? ''));

    const itemsHtml = identity.trials
      .map((trial, index) => {
        const mask = sanitizeForHtml(trial.method_mask);
        const variant = sanitizeForHtml(trial.variant || '');
        const thumb = sanitizeForHtml(trial.thumb_url || trial.image_url);
        const zoom = sanitizeForHtml(trial.image_url);
        const label = variant ? `Method ${mask} - ${variant}` : `Method ${mask}`;
        return `
          <li class="ranking-item"
              draggable="true"
              role="option"
              aria-label="${label}"
              tabindex="0"
              data-mask="${encodeAttr(trial.method_mask)}"
              data-method="${encodeAttr(trial.method_true)}"
              data-variant="${encodeAttr(trial.variant || '')}">
            <div class="ranking-item__badge" data-rank-value="${index + 1}" aria-hidden="true">${index + 1}</div>
            <div class="ranking-item__thumb">
              <img src="${thumb}"
                   data-zoom-src="${zoom}"
                   alt="Caricature preview for ${label}">
            </div>
            <div class="ranking-item__body">
              <p class="ranking-item__label">${label}</p>
              <div class="ranking-item__controls" aria-hidden="true">
                <span class="ranking-item__handle" aria-hidden="true">&#8942;&#8942;</span>
                <button type="button"
                        class="ranking-item__control ranking-item__control--up"
                        data-direction="up"
                        aria-label="Move ${label} up one rank">
                  &#9650;
                </button>
                <button type="button"
                        class="ranking-item__control ranking-item__control--down"
                        data-direction="down"
                        aria-label="Move ${label} down one rank">
                  &#9660;
                </button>
              </div>
              <span class="ranking-item__sr" aria-live="polite">Rank ${index + 1}</span>
            </div>
          </li>
        `;
      })
      .join('');

    const referenceSource = identity.reference_url ||
      identity.trials.find((trial) => trial.reference_url)?.reference_url ||
      identity.trials.find((trial) => trial.metadata?.reference_url)?.metadata?.reference_url ||
      identity.trials[0]?.image_url ||
      '';

    const referenceLabel =
      sanitizeForHtml(
        identity.trials.find((trial) => trial.metadata?.reference_label)?.metadata?.reference_label ||
          identity.reference_label ||
          'Reference face'
      );

    const referenceHtml = referenceSource
      ? `
          <aside class="ranking-preview" data-preview>
            <header class="ranking-preview__header">
              <div>
                <h3 class="ranking-preview__title">Preview</h3>
                <p class="ranking-preview__subtitle">${referenceLabel}</p>
              </div>
              <button type="button" class="ranking-preview__toggle" data-preview-toggle aria-expanded="true">
                Hide
              </button>
            </header>
            <div class="ranking-preview__media" data-preview-media>
              <img src="${sanitizeForHtml(referenceSource)}"
                   alt="${referenceLabel}"
                   class="ranking-preview__image"
                   data-zoom-src="${sanitizeForHtml(referenceSource)}">
              <button type="button" class="zoom-trigger ranking-preview__zoom" data-zoom-src="${sanitizeForHtml(referenceSource)}">
                Zoom reference
              </button>
            </div>
            <div class="ranking-preview__legend">
              <span>Top = Rank 1 (Best)</span>
              <span>Bottom = Rank 4 (Worst)</span>
            </div>
          </aside>
        `
      : '';

    return {
      type: jsPsychSurveyHtmlForm,
      html: `
        <div class="panel ranking-panel">
          <header class="ranking-panel__header">
            <div>
              <h2>${sanitizeForHtml(identity.identity_display || identity.identity_id)}</h2>
              <p class="ranking-panel__instruction">Please rank the four caricatures from best (top) to worst (bottom).</p>
              <p class="ranking-panel__subtext">Drag and drop the images to reorder them. Rank 1 = best caricature.</p>
            </div>
          </header>
          <div class="ranking-board">
            <section class="ranking-workspace" aria-label="Caricature ranking">
              <ul class="ranking-list" id="ranking-list" role="listbox" aria-orientation="vertical">
                ${itemsHtml}
              </ul>
              <div class="ranking-legend">
                <span class="ranking-legend__badge">1</span>
                <span>Best caricature</span>
                <span class="ranking-legend__badge">4</span>
                <span>Lowest ranked caricature</span>
              </div>
              <input type="hidden" name="rank_order" id="rank_order" required>
            </section>
            ${referenceHtml}
          </div>
          <label class="ranking-panel__rationale">
            Briefly explain your ranking rationale (required)
            <textarea name="rationale" rows="4" required placeholder="Summarize how you ranked the caricatures."></textarea>
          </label>
          <p id="rank-error" class="error-text hidden">Please reorder the items to set a ranking before continuing.</p>
        </div>
      `,
      button_label: 'Submit ranking',
      data: {
        trial_category: 'comparative_rank',
        identity_id: identity.identity_id,
        identity_display: identity.identity_display,
        method_map: identity.trials.map((trial) => ({
          mask: trial.method_mask,
          method: trial.method_true,
          variant: trial.variant
        })),
        participant_id: participantId
      },
      on_load: () => {
        const container = document.getElementById('jspsych-survey-html-form');
        if (!container) {
          return;
        }
        setupZoomHandlers(container);
        const form = container.querySelector('form');
        const list = container.querySelector('#ranking-list');
        const hiddenInput = container.querySelector('#rank_order');
        const error = container.querySelector('#rank-error');
        const toggleButton = container.querySelector('[data-preview-toggle]');
        const preview = container.querySelector('[data-preview]');
        const previewMedia = container.querySelector('[data-preview-media]');

        const updateRanks = () => {
          if (!list) {
            return;
          }
          const items = Array.from(list.children);
          items.forEach((item, index) => {
            const badge = item.querySelector('[data-rank-value]');
            const sr = item.querySelector('.ranking-item__sr');
            if (badge) {
              badge.textContent = String(index + 1);
              badge.setAttribute('data-rank-value', String(index + 1));
            }
            if (sr) {
              sr.textContent = `Rank ${index + 1}`;
            }
            item.setAttribute('aria-posinset', String(index + 1));
            item.setAttribute('aria-setsize', String(items.length));
          });
        };

        const updateHidden = () => {
          if (!hiddenInput || !list) {
            return;
          }
          const order = Array.from(list.children).map((item, idx) => ({
            method_mask: decodeURIComponent(item.dataset.mask || ''),
            method_true: decodeURIComponent(item.dataset.method || ''),
            variant: decodeURIComponent(item.dataset.variant || ''),
            rank: idx + 1
          }));
          hiddenInput.value = JSON.stringify(order);
          updateRanks();
        };

        const clearDropHighlights = () => {
          list?.querySelectorAll('.ranking-item--drop-target').forEach((el) =>
            el.classList.remove('ranking-item--drop-target')
          );
          list?.classList.remove('ranking-list--drop-end');
        };

        const setDropHighlight = (element) => {
          clearDropHighlights();
          if (!list) {
            return;
          }
          if (element) {
            element.classList.add('ranking-item--drop-target');
          } else {
            list.classList.add('ranking-list--drop-end');
          }
        };

        const getDragAfterElement = (containerEl, y) => {
          const draggableElements = [
            ...containerEl.querySelectorAll('.ranking-item:not(.dragging)')
          ];

          return draggableElements.reduce(
            (closest, child) => {
              const box = child.getBoundingClientRect();
              const offset = y - box.top - box.height / 2;
              if (offset < 0 && offset > closest.offset) {
                return { offset, element: child };
              }
              return closest;
            },
            { offset: Number.NEGATIVE_INFINITY, element: null }
          ).element;
        };

        list?.addEventListener('dragover', (event) => {
          event.preventDefault();
          const dragging = list.querySelector('.dragging');
          if (!dragging) {
            return;
          }
          const afterElement = getDragAfterElement(list, event.clientY);
          setDropHighlight(afterElement);
          if (!afterElement) {
            list.appendChild(dragging);
          } else {
            list.insertBefore(dragging, afterElement);
          }
        });

        list?.addEventListener('dragenter', (event) => {
          event.preventDefault();
        });

        list?.addEventListener('dragleave', (event) => {
          if (event.relatedTarget && list?.contains(event.relatedTarget)) {
            return;
          }
          clearDropHighlights();
        });

        list?.addEventListener('dragstart', (event) => {
          const target = event.target;
          if (target instanceof HTMLElement) {
            target.classList.add('dragging');
            target.setAttribute('aria-grabbed', 'true');
          }
        });

        list?.addEventListener('dragend', (event) => {
          const target = event.target;
          if (target instanceof HTMLElement) {
            target.classList.remove('dragging');
            target.removeAttribute('aria-grabbed');
            clearDropHighlights();
            updateHidden();
          }
        });

        const moveItem = (item, direction) => {
          if (!list || !item) {
            return;
          }
          if (direction === 'up') {
            const previous = item.previousElementSibling;
            if (previous) {
              list.insertBefore(item, previous);
            }
          } else if (direction === 'down') {
            const next = item.nextElementSibling;
            if (next) {
              list.insertBefore(next, item);
            }
          }
          item.classList.add('ranking-item--moved');
          window.setTimeout(() => item.classList.remove('ranking-item--moved'), 300);
          updateHidden();
          item.focus();
        };

        list?.addEventListener('click', (event) => {
          const button = event.target instanceof HTMLElement ? event.target.closest('.ranking-item__control') : null;
          if (!button) {
            return;
          }
          const item = button.closest('.ranking-item');
          const direction = button.dataset.direction;
          if (item && direction) {
            event.preventDefault();
            moveItem(item, direction);
          }
        });

        list?.addEventListener('keydown', (event) => {
          const target = event.target instanceof HTMLElement ? event.target.closest('.ranking-item') : null;
          if (!target) {
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            moveItem(target, 'up');
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            moveItem(target, 'down');
          } else if (event.key === ' ') {
            target.classList.toggle('ranking-item--keyboard-grab');
            const isGrabbed = target.classList.contains('ranking-item--keyboard-grab');
            target.setAttribute('aria-grabbed', String(isGrabbed));
            event.preventDefault();
          }
        });

        form?.addEventListener('submit', (event) => {
          updateHidden();
          if (!hiddenInput?.value) {
            event.preventDefault();
            error?.classList.remove('hidden');
          } else {
            error?.classList.add('hidden');
          }
        });

        toggleButton?.addEventListener('click', () => {
          if (!preview || !previewMedia || !toggleButton) {
            return;
          }
          const isHidden = preview.classList.toggle('ranking-preview--collapsed');
          previewMedia.setAttribute('aria-hidden', String(isHidden));
          toggleButton.setAttribute('aria-expanded', String(!isHidden));
          toggleButton.textContent = isHidden ? 'Show' : 'Hide';
        });

        updateHidden();
      },
      on_finish: (data) => {
        const response = data.response || {};
        const orderJson = response.rank_order || '[]';
        let parsedOrder = [];
        try {
          parsedOrder = JSON.parse(orderJson);
        } catch (error) {
          parsedOrder = [];
        }
        const rankings = parsedOrder.map((entry, index) => {
          const mapping = data.method_map.find(
            (item) => item.mask === entry.method_mask
          );
          return {
            method_mask: entry.method_mask,
            method_true: mapping?.method || entry.method_true || null,
            variant: mapping?.variant || entry.variant || null,
            rank: index + 1
          };
        });
        data.rankings = rankings;
        data.rationale = response.rationale || '';
      }
    };
  }
  function createInstructionalAttentionTrial(config) {
    return {
      type: jsPsychSurveyMultiChoice,
      preamble: `
        <div class="panel">
          <h2>Instructional Attention Check</h2>
          <p class="attention-banner">${sanitizeForHtml(config.prompt)}</p>
        </div>
      `,
      questions: [
        {
          prompt: 'Please follow the instruction above.',
          name: 'attention_select_6',
          options: ['1', '2', '3', '4', '5', '6', '7'],
          required: true
        }
      ],
      button_label: 'Continue',
      data: {
        trial_category: 'attention_check',
        attention_kind: 'instructional',
        participant_id: participantId
      },
      on_finish: (data) => {
        const selected = data.response?.attention_select_6;
        data.pass = selected === '6';
      }
    };
  }

  function createObviousPairTrial(config) {
    return {
      type: jsPsychSurveyHtmlForm,
      html: `
        <div class="panel">
          <h2>Plausibility Attention Check</h2>
          <p>${sanitizeForHtml(config.prompt)}</p>
          <div class="obvious-pair">
            <div class="obvious-pair__card">
              <img src="${sanitizeForHtml(config.left.thumb_url || config.left.image_url)}"
                   data-zoom-src="${sanitizeForHtml(config.left.image_url)}"
                   alt="Left caricature attention check" />
              <div class="obvious-pair__choice">
                <input type="radio" id="attention-left" name="plausible_winner" value="left" required />
                <label for="attention-left">Select left image</label>
              </div>
              <button type="button" class="zoom-trigger" data-zoom-src="${sanitizeForHtml(
                config.left.image_url
              )}">Zoom left</button>
            </div>
            <div class="obvious-pair__card">
              <img src="${sanitizeForHtml(config.right.thumb_url || config.right.image_url)}"
                   data-zoom-src="${sanitizeForHtml(config.right.image_url)}"
                   alt="Right caricature attention check" />
              <div class="obvious-pair__choice">
                <input type="radio" id="attention-right" name="plausible_winner" value="right" required />
                <label for="attention-right">Select right image</label>
              </div>
              <button type="button" class="zoom-trigger" data-zoom-src="${sanitizeForHtml(
                config.right.image_url
              )}">Zoom right</button>
            </div>
          </div>
        </div>
      `,
      button_label: 'Submit attention response',
      data: {
        trial_category: 'attention_check',
        attention_kind: 'obvious_pair',
        identity_id: config.identity_id,
        left: config.left,
        right: config.right,
        participant_id: participantId
      },
      on_load: () => {
        setupZoomHandlers(document);
      },
      on_finish: (data) => {
        const chosen = data.response?.plausible_winner;
        data.selection = chosen;
        data.correct_choice = config.correct;
        data.pass = chosen === config.correct;
      }
    };
  }

  function buildDemographicsTrial() {
    return {
      type: jsPsychSurveyHtmlForm,
      html: `
        <div class="panel">
          <h2>Demographics</h2>
          <p>Please share a few details to contextualize the results. You may skip optional questions.</p>
          <div class="demographic-grid">
            <label class="demographic-field">
              <span>Age (optional)</span>
              <input type="number" name="age" min="0" max="120" placeholder="e.g., 28">
            </label>
            <label class="demographic-field">
              <span>Gender (optional)</span>
              <select name="gender">
                <option value="">Prefer not to say</option>
                <option value="woman">Woman</option>
                <option value="man">Man</option>
                <option value="non-binary">Non-binary</option>
                <option value="self-describe">Self describe</option>
              </select>
            </label>
            <label class="demographic-field">
              <span>Experience with caricature or portrait art <span aria-hidden="true">*</span></span>
              <select name="experience" required>
                <option value="" disabled selected>Select one</option>
                <option value="None">None</option>
                <option value="Hobbyist">Hobbyist</option>
                <option value="Professional caricature artist">Professional caricature artist</option>
                <option value="Researcher / scientist">Researcher / scientist</option>
                <option value="Other">Other</option>
              </select>
            </label>
            <label class="demographic-field">
              <span>Anything else we should know? (optional)</span>
              <textarea name="notes" rows="3" placeholder="Add details about your approach, display, or feedback."></textarea>
            </label>
          </div>
        </div>
      `,
      button_label: 'Submit demographics',
      data: { trial_category: 'demographics', participant_id: participantId },
      on_finish: (data) => {
        data.demographics = data.response;
      }
    };
  }

  function buildDebriefTrial() {
    return {
      type: jsPsychHtmlButtonResponse,
      stimulus: `
        <div class="panel">
          <h2>Debrief</h2>
          <p>Thank you for contributing to this caricature perception study. Your ratings will help evaluate different generation approaches while masking the underlying methods.</p>
          <p>On the next screen you can download your CSV and JSON data exports, including the per-trial responses and the method-to-mask mapping for decoding.</p>
        </div>
      `,
      choices: ['Continue'],
      data: { trial_category: 'debrief', participant_id: participantId }
    };
  }

  function buildExportPromptTrial() {
    return {
      type: jsPsychHtmlButtonResponse,
      stimulus: `
        <div class="panel">
          <h2>Prepare Data</h2>
          <p>Click “Finish &amp; review” to generate your downloadable files.</p>
        </div>
      `,
      choices: ['Finish & review'],
      data: { trial_category: 'prepare_export', participant_id: participantId }
    };
  }
  function buildDataExports(exitReason) {
    const data = jsPsychInstance.data;
    const ratingTrials = data.filter({ trial_category: 'caricature_rating' }).values();
    const comparativeTrials = data.filter({ trial_category: 'comparative_choices' }).values();
    const rankingTrials = data.filter({ trial_category: 'comparative_rank' }).values();
    const attentionTrials = data.filter({ trial_category: 'attention_check' }).values();
    const demographicsTrial = data
      .filter({ trial_category: 'demographics' })
      .values()
      .slice(-1)[0] || null;

    const stimulusRows = ratingTrials.map((trial, index) => ({
      participant_id: participantId,
      sequence_index: index + 1,
      identity_id: trial.identity_id,
      identity_display: trial.identity_display,
      method_mask: trial.method_mask,
      method_true: trial.method_true,
      variant: trial.variant,
      reference_url: trial.reference_url || '',
      identity: trial.identity,
      exaggeration: trial.exaggeration,
      alignment: trial.alignment,
      plausibility: trial.plausibility,
      overall: trial.overall,
      rt_ms: trial.rt ?? '',
      end_timestamp: trial.end_timestamp || ''
    }));

    const comparativeRows = comparativeTrials.map((trial) => ({
      participant_id: participantId,
      identity_id: trial.identity_id,
      identity_display: trial.identity_display,
      winner_likeness: trial.response?.winner_likeness || '',
      winner_style: trial.response?.winner_style || '',
      winner_expression: trial.response?.winner_expression || '',
      winner_overall: trial.response?.winner_overall || '',
      end_timestamp: trial.end_timestamp || ''
    }));

    const rankingRows = rankingTrials.map((trial) => ({
      participant_id: participantId,
      identity_id: trial.identity_id,
      identity_display: trial.identity_display,
      rankings: (trial.rankings || []).map((entry) => ({
        method_mask: entry.method_mask,
        method_true: entry.method_true,
        variant: entry.variant,
        rank: entry.rank
      })),
      rationale: trial.rationale || '',
      end_timestamp: trial.end_timestamp || ''
    }));

    const attentionRows = attentionTrials.map((trial) => ({
      participant_id: participantId,
      attention_kind: trial.attention_kind,
      selection: trial.selection ?? trial.response,
      pass: trial.pass,
      correct_choice: trial.correct_choice ?? null,
      end_timestamp: trial.end_timestamp || ''
    }));

    const demographics = demographicsTrial?.demographics || {};

    const summary = {
      participant_id: participantId,
      exit_reason: exitReason,
      generated_at: new Date().toISOString(),
      method_mask_map: methodMaskMap,
      stimuli_source: 'stimuli.csv',
      counts: {
        stimulus_trials: stimulusRows.length,
        identities_completed: new Set(stimulusRows.map((row) => row.identity_id)).size,
        attention_checks: attentionRows.length
      }
    };

    const stimulusHeaders = [
      'participant_id',
      'sequence_index',
      'identity_id',
      'identity_display',
      'method_mask',
      'method_true',
      'variant',
      'reference_url',
      'identity',
      'exaggeration',
      'alignment',
      'plausibility',
      'overall',
      'rt_ms',
      'end_timestamp'
    ];
    const comparativeHeaders = [
      'participant_id',
      'identity_id',
      'identity_display',
      'winner_likeness',
      'winner_style',
      'winner_expression',
      'winner_overall',
      'end_timestamp'
    ];

    const csvStimulus = toCsv(stimulusRows, stimulusHeaders);
    const csvComparative = toCsv(comparativeRows, comparativeHeaders);
    const jsonPayload = JSON.stringify(
      {
        summary,
        stimulus_responses: stimulusRows,
        comparative_responses: comparativeRows,
        ranking_responses: rankingRows,
        attention_checks: attentionRows,
        demographics,
        raw_trials: data.values()
      },
      null,
      2
    );

    return {
      summary,
      csvStimulus,
      csvComparative,
      jsonPayload
    };
  }

  function toCsv(rows, headerKeys = []) {
    const normalizedRows = Array.isArray(rows) ? rows : [];
    const headers = normalizedRows.length
      ? Object.keys(normalizedRows[0])
      : headerKeys;
    if (!headers.length) {
      return '';
    }
    const lines = [headers.join(',')];
    normalizedRows.forEach((row) => {
      const values = headers.map((header) => csvEscape(row[header]));
      lines.push(values.join(','));
    });
    return lines.join('\r\n');
  }

  function csvEscape(value) {
    if (value === null || value === undefined) {
      return '';
    }
    const str = String(value);
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function finalizeExperiment(exitReason) {
    if (finalScreenRendered) {
      return;
    }
    finalScreenRendered = true;
    quitEl.classList.add('hidden');
    closeModal();

    const exports = buildDataExports(exitReason);
    const idForFile = (participantId || 'participant').replace(/[^A-Za-z0-9_-]/g, '_');
    const summary = exports.summary;
    const statusClass = summary.counts.stimulus_trials
      ? 'summary-status'
      : 'summary-status summary-status--warning';

    experimentEl.innerHTML = `
      <div class="panel">
        <h2>${exitReason === 'quit' ? 'Session ended early' : 'Session complete'}</h2>
        <p>Participant ID: <strong>${sanitizeForHtml(participantId)}</strong></p>
        <p class="${statusClass}">
          ${summary.counts.stimulus_trials ? 'Data ready for download' : 'No main trials recorded – verify stimuli.csv'}
        </p>
        <div class="download-grid">
          <button id="download-stimulus" class="primary-btn" type="button">Download stimulus responses (CSV)</button>
          <button id="download-comparative" class="secondary-btn" type="button">Download comparative summary (CSV)</button>
          <button id="download-json" class="secondary-btn" type="button">Download full session (JSON)</button>
        </div>
        <p>You can re-run the study later with the same participant ID to collect additional variants. Keep the method-mask mapping below for decoding.</p>
        <div class="mask-map" aria-label="Method mask mapping">
          ${Object.keys(methodMaskMap).length
            ? Object.entries(methodMaskMap)
                .map(([method, mask]) => `${mask} -> ${method}`)
                .join('\n')
            : 'No method mapping available. Add stimuli to stimuli.csv to assign masks.'}
        </div>
        <p style="margin-top: 24px; font-size: 0.9rem; color: var(--muted);">
          Hosting tip: run <code>python -m http.server</code> inside <code>caricature-survey/</code> to serve these files locally.
        </p>
      </div>
    `;

    const stimulusButton = document.getElementById('download-stimulus');
    const comparativeButton = document.getElementById('download-comparative');
    const jsonButton = document.getElementById('download-json');

    stimulusButton?.addEventListener('click', () => {
      if (!exports.csvStimulus) {
        window.alert('No stimulus responses recorded in this session.');
        return;
      }
      downloadFile(`caricature_stimulus_${idForFile}.csv`, exports.csvStimulus, 'text/csv');
    });

    comparativeButton?.addEventListener('click', () => {
      if (!exports.csvComparative) {
        window.alert('No comparative responses recorded in this session.');
        return;
      }
      downloadFile(`caricature_comparative_${idForFile}.csv`, exports.csvComparative, 'text/csv');
    });

    jsonButton?.addEventListener('click', () => {
      downloadFile(`caricature_session_${idForFile}.json`, exports.jsonPayload, 'application/json');
    });

    const autoDownloads = [
      {
        content: exports.csvStimulus,
        filename: `caricature_stimulus_${idForFile}.csv`,
        mime: 'text/csv'
      },
      {
        content: exports.csvComparative,
        filename: `caricature_comparative_${idForFile}.csv`,
        mime: 'text/csv'
      },
      {
        content: exports.jsonPayload,
        filename: `caricature_session_${idForFile}.json`,
        mime: 'application/json'
      }
    ];

    autoDownloads.forEach((bundle, index) => {
      if (bundle.content && bundle.content.length) {
        setTimeout(() => {
          downloadFile(bundle.filename, bundle.content, bundle.mime);
        }, 300 * index);
      }
    });
  }

  async function bootstrap() {
    updateViewportGuard();
    try {
      stimuliRows = await loadStimuli();
      experimentPlan = prepareExperimentPlan(stimuliRows);
    } catch (error) {
      loadingEl.innerHTML = `
        <div class="panel">
          <h2>Could not load stimuli.csv</h2>
          <p>${sanitizeForHtml(error.message)}</p>
          <p>Ensure you are running a local server (e.g., <code>python -m http.server</code>) from the <code>caricature-survey</code> directory before loading this page.</p>
        </div>
      `;
      return;
    }
    stimuliLoaded = true;
    if (isViewportAllowed()) {
      startExperiment();
    } else {
      loadingEl.classList.add('hidden');
    }
  }

  window.addEventListener('resize', updateViewportGuard);
  modalCloseEl.addEventListener('click', () => closeModal());
  modalEl.addEventListener('click', (event) => {
    if (event.target === modalEl) {
      closeModal();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeModal();
    }
  });
  quitButton.addEventListener('click', () => {
    if (!jsPsychInstance) {
      return;
    }
    const confirmQuit = window.confirm('Are you sure you want to quit the study? You will still be able to download any data collected so far.');
    if (confirmQuit) {
      experimentExitReason = 'quit';
      jsPsychInstance.endExperiment('You have exited the study early. Please download your data before closing this window.');
    }
  });

  bootstrap();
})();





