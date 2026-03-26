import chalk from "chalk";
import { Box, Text, useStdout } from "ink";
import fs from "node:fs";
import { createElement, useEffect, useRef, useState } from "react";

import { truncateAnsi } from "./ansi-utils.mjs";
import {
  CALL_STACK_RATIO,
  CONSOLE_RATIO,
  MAX_PLAY_SPEED_MS,
  MIN_PLAY_SPEED_MS,
  PANEL_CHROME,
  QUEUES_RATIO,
  SCROLL_OFFSET_LINES,
} from "./constants.mjs";
import {
  getTaskBadge,
  getTypeIcon,
  pathsMatch,
  renderProgressBar,
  sliceContent,
} from "./helpers.mjs";
import { HelpOverlay } from "./HelpOverlay.mjs";
import { useKeyboardInput, useNavigation, usePlayback } from "./hooks.mjs";
import { Panel } from "./Panel.mjs";
import { PHASE_COLORS } from "./state.mjs";
import { highlightSyntax } from "./syntax-highlight.mjs";

const h = createElement;

/** Updates displayFileRef based on the current event's file context. */
function updateDisplayFile(
  displayFileRef,
  { focusFile, isExternal, eventFile, getSourceLines }
) {
  if (focusFile && isExternal) {
    displayFileRef.current = focusFile;
  } else if (
    eventFile &&
    !pathsMatch(eventFile, displayFileRef.current || "")
  ) {
    if (getSourceLines(eventFile)) displayFileRef.current = eventFile;
  }
}

/** Returns the source panel label and color based on file navigation state. */
function getSourceLabel({
  isExternal,
  isExternalFile,
  displayFileName,
  eventFile,
  focusFile,
  displayFile,
  phaseColor,
}) {
  const externalFileName =
    isExternal && eventFile ? eventFile.split(/[\/\\]/).pop() : null;

  let sourceLabel;
  if (isExternal && displayFile === focusFile) {
    sourceLabel =
      "Source: " +
      (displayFileName || "?") +
      " \u2192 " +
      (externalFileName || "?");
  } else if (isExternalFile) {
    sourceLabel = "Source: \u21AA " + displayFileName;
  } else {
    sourceLabel = "Source: " + (displayFileName || "untitled");
  }

  const sourceColor = isExternalFile ? "gray" : phaseColor;
  return { sourceLabel, sourceColor };
}

/** Determines which line to highlight in the source panel. */
function getHighlightLine({
  displayLines,
  isExternal,
  displayFile,
  focusFile,
  eventFocusLine,
  evt,
}) {
  if (!displayLines) return { highlightLine: null, highlightExternal: false };

  if (isExternal && displayFile === focusFile) {
    return { highlightLine: eventFocusLine || null, highlightExternal: true };
  }

  const fileMatches =
    !evt?.file || evt.file === displayFile || pathsMatch(evt.file, displayFile);
  if (evt?.line && displayFile && fileMatches) {
    return { highlightLine: evt.line, highlightExternal: false };
  }

  return { highlightLine: null, highlightExternal: false };
}

export function App({ events, sourceCode, sourcePath, focusFile }) {
  const { stdout } = useStdout();

  // --- Terminal size tracking ---
  const [termSize, setTermSize] = useState({
    rows: stdout.rows || 24,
    cols: stdout.columns || 80,
  });
  useEffect(() => {
    const onResize = () =>
      setTermSize({ rows: stdout.rows || 24, cols: stdout.columns || 80 });
    stdout.on("resize", onResize);
    return () => stdout.off("resize", onResize);
  }, [stdout]);
  const { rows, cols } = termSize;

  // --- Core navigation state ---
  const nav = useNavigation({ events, sourcePath });
  const {
    stateRef,
    currentStepRef,
    displayFileRef,
    scrollOffsetsRef,
    prevLogLenRef,
    prevConsoleLenRef,
    prevMemoryRef,
    hasTests,
    totalSteps,
    nextStep,
    prevStep,
    reset,
    nextTest,
    prevTest,
    setRenderTick,
  } = nav;

  // --- Playback ---
  const playback = usePlayback(nextStep);
  const { playing, speed, togglePlay, speedUp, speedDown, stopPlay } = playback;

  // --- UI state ---
  const [focusIndex, setFocusIndex] = useState(0);
  const [showHelp, setShowHelp] = useState(false);

  // --- Keyboard input ---
  useKeyboardInput({
    showHelp,
    setShowHelp,
    focusIndex,
    setFocusIndex,
    scrollOffsetsRef,
    setRenderTick,
    nextStep,
    prevStep,
    reset,
    nextTest,
    prevTest,
    stopPlay,
    togglePlay,
    speedUp,
    speedDown,
  });

  // --- Source cache ---
  const sourceCacheRef = useRef(new Map());
  if (sourcePath && sourceCode && !sourceCacheRef.current.has(sourcePath)) {
    sourceCacheRef.current.set(sourcePath, sourceCode.split("\n"));
  }

  function getSourceLines(filePath) {
    if (!filePath) return null;
    const cache = sourceCacheRef.current;
    if (cache.has(filePath)) return cache.get(filePath);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n");
      cache.set(filePath, lines);
      return lines;
    } catch (_) {
      return null;
    }
  }

  // --- Layout ---
  const headerHeight = 3;
  const footerHeight = 3;
  const mainHeight = rows - headerHeight - footerHeight;

  const callStackHeight = Math.max(
    4,
    Math.round(mainHeight * CALL_STACK_RATIO)
  );
  const queuesHeight = Math.max(4, Math.round(mainHeight * QUEUES_RATIO));
  const eventLogHeight = mainHeight - callStackHeight - queuesHeight;

  const sourceHeight = callStackHeight + queuesHeight;
  const consoleHeight = Math.max(4, Math.round(mainHeight * CONSOLE_RATIO));
  const memoryHeight = mainHeight - sourceHeight - consoleHeight;

  const sourceContentH = Math.max(0, sourceHeight - PANEL_CHROME);
  const consoleContentH = Math.max(0, consoleHeight - PANEL_CHROME);
  const memoryContentH = Math.max(0, memoryHeight - PANEL_CHROME);
  const callStackContentH = Math.max(0, callStackHeight - PANEL_CHROME);
  const microContentH = Math.max(0, queuesHeight - PANEL_CHROME);
  const macroContentH = Math.max(0, queuesHeight - PANEL_CHROME);
  const eventLogContentH = Math.max(0, eventLogHeight - PANEL_CHROME);

  const leftColWidth = Math.floor(cols / 2);
  const rightColWidth = cols - leftColWidth;
  const leftContentW = Math.max(0, leftColWidth - 2);
  const rightContentW = Math.max(0, rightColWidth - 2);
  const microQueueWidth = Math.floor(rightColWidth / 2);
  const macroQueueWidth = rightColWidth - microQueueWidth;
  const queueContentW = Math.max(0, microQueueWidth - 2);

  // --- Build panel content ---
  const state = stateRef.current;
  const phaseTheme = PHASE_COLORS[state.phase] || PHASE_COLORS["Ready"];
  const currentStep = currentStepRef.current;
  const evt = currentStep >= 0 ? events[currentStep] : null;
  const eventFile = evt && evt.file;
  const isExternal = evt && evt.external;
  const eventFocusLine = evt && evt.focusLine;

  // --- Determine which source file to display ---
  updateDisplayFile(displayFileRef, {
    focusFile,
    isExternal,
    eventFile,
    getSourceLines,
  });

  const displayLines =
    getSourceLines(displayFileRef.current) || getSourceLines(sourcePath);
  const displayFileName = displayFileRef.current
    ? displayFileRef.current.split(/[\/\\]/).pop()
    : null;
  const isExternalFile =
    focusFile && displayFileRef.current && displayFileRef.current !== focusFile;

  // --- Source panel label ---
  const { sourceLabel, sourceColor } = getSourceLabel({
    isExternal,
    isExternalFile,
    displayFileName,
    eventFile,
    focusFile,
    displayFile: displayFileRef.current,
    phaseColor: phaseTheme.primary,
  });

  // --- Highlighted source line ---
  const { highlightLine, highlightExternal } = getHighlightLine({
    displayLines,
    isExternal,
    displayFile: displayFileRef.current,
    focusFile,
    eventFocusLine,
    evt,
  });

  if (highlightLine) {
    scrollOffsetsRef.current[0] = Math.max(
      0,
      highlightLine - 1 - SCROLL_OFFSET_LINES
    );
  }

  // Source panel content
  let sourceContent;
  if (displayLines) {
    const padWidth = String(displayLines.length).length;
    const maxOffset = Math.max(0, displayLines.length - sourceContentH);
    const offset = Math.min(scrollOffsetsRef.current[0], maxOffset);
    scrollOffsetsRef.current[0] = Math.max(0, offset);
    const visibleEnd = Math.min(offset + sourceContentH, displayLines.length);

    sourceContent = [];
    for (let i = offset; i < visibleEnd; i++) {
      const lineNum = i + 1;
      const num = String(lineNum).padStart(Math.max(3, padWidth), " ");
      const line = (displayLines[i] || "").replace(/\t/g, "  ");

      let formatted;
      if (highlightLine === lineNum) {
        formatted = highlightExternal
          ? chalk.bgYellow.black(" " + num + "  " + line + " ")
          : chalk.bgWhite.black.bold(" " + num + "  " + line + " ");
      } else {
        formatted = chalk.gray(num) + "  " + highlightSyntax(line);
      }
      sourceContent.push(
        leftContentW > 0 ? truncateAnsi(formatted, leftContentW) : formatted
      );
    }
  } else {
    sourceContent = [chalk.gray("[Command mode \u2014 source not available]")];
  }

  // Auto-scroll console and event log
  if (
    state.console.length > prevConsoleLenRef.current &&
    state.console.length > consoleContentH
  ) {
    scrollOffsetsRef.current[2] = state.console.length - consoleContentH;
  }
  if (
    state.log.length > prevLogLenRef.current &&
    state.log.length > eventLogContentH
  ) {
    scrollOffsetsRef.current[3] = state.log.length - eventLogContentH;
  }

  const consoleContent = sliceContent(
    state.console,
    2,
    consoleContentH,
    leftContentW,
    scrollOffsetsRef
  );

  // Memory panel with change detection
  const changedVars = new Set();
  for (const [name, val] of state.memory) {
    if (
      !prevMemoryRef.current.has(name) ||
      prevMemoryRef.current.get(name) !== val
    ) {
      changedVars.add(name);
    }
  }

  const consoleLen = state.console.length;
  const logLen = state.log.length;
  const memorySnapshot = new Map(state.memory);

  const memoryLines =
    state.memory.size === 0
      ? [chalk.gray("(no variables tracked)")]
      : Array.from(state.memory, ([name, val]) => {
          const isChanged = changedVars.has(name);
          const typeIcon = getTypeIcon(val);
          const nameText = isChanged
            ? chalk.bgYellow.black.bold(" " + name + " ")
            : chalk.bold(name);
          const valText = isChanged ? chalk.magentaBright(val) : val;
          return " " + typeIcon + " " + nameText + " = " + valText;
        });
  const memoryContent = sliceContent(
    memoryLines,
    1,
    memoryContentH,
    leftContentW,
    scrollOffsetsRef
  );

  const eventLogContent = sliceContent(
    state.log,
    3,
    eventLogContentH,
    rightContentW,
    scrollOffsetsRef
  );

  const callStackLines =
    state.callStack.length === 0
      ? [chalk.gray("(empty)")]
      : state.callStack.map((s, i) => {
          const isTop = i === state.callStack.length - 1;
          const indent = "\u2502 ".repeat(i);
          const prefix = isTop ? chalk.green("\u25B6") : chalk.gray("\u2502");
          const text = isTop ? chalk.bold(s) : chalk.gray(s);
          return " " + indent + prefix + " " + text;
        });
  const callStackContent = sliceContent(
    callStackLines,
    4,
    callStackContentH,
    rightContentW,
    scrollOffsetsRef
  );

  const microLines =
    state.microQueue.length === 0
      ? [chalk.gray("(empty)")]
      : state.microQueue.map((item, i) => {
          const badge = getTaskBadge(item.label);
          const isFirst = i === 0;
          const text = isFirst ? chalk.bold.cyanBright(item.label) : item.label;
          return " " + badge + " " + (i + 1) + ". " + text;
        });
  const microContent = sliceContent(
    microLines,
    5,
    microContentH,
    queueContentW,
    scrollOffsetsRef
  );

  const macroLines =
    state.macroQueue.length === 0
      ? [chalk.gray("(empty)")]
      : state.macroQueue.map((item, i) => {
          const badge = getTaskBadge(item.label);
          const isFirst = i === 0;
          const text = isFirst ? chalk.bold.redBright(item.label) : item.label;
          return " " + badge + " " + (i + 1) + ". " + text;
        });
  const macroContent = sliceContent(
    macroLines,
    6,
    macroContentH,
    queueContentW,
    scrollOffsetsRef
  );

  // Header / footer
  const phaseColorFn = chalk[phaseTheme.primary] || chalk.white;
  const phaseAccentFn = chalk[phaseTheme.accent] || chalk.white;
  const stepLabel = currentStep < 0 ? "0" : String(currentStep + 1);
  const playIcon = playing
    ? chalk.green("\u25B6") + " Playing"
    : chalk.gray("\u23F8") + " Paused";
  const phaseIndicator =
    phaseAccentFn("\u25CF") + " " + phaseColorFn.bold(state.phase);
  const speedNormalized =
    (speed - MIN_PLAY_SPEED_MS) / (MAX_PLAY_SPEED_MS - MIN_PLAY_SPEED_MS);
  const speedBars = 5;
  const filledBars = Math.round((1 - speedNormalized) * speedBars);
  const speedVisual =
    chalk.cyan("\u25AE".repeat(filledBars)) +
    chalk.gray("\u25AF".repeat(speedBars - filledBars));

  const headerText =
    " " +
    chalk.bold("Event Loop Visualizer") +
    "  " +
    chalk.gray("Step ") +
    chalk.bold(stepLabel + "/" + totalSteps) +
    "  " +
    phaseIndicator +
    "  " +
    playIcon +
    "  " +
    speedVisual +
    " " +
    speed +
    "ms";

  const progressBarWidth = Math.floor(cols / 3);
  const progressBar = renderProgressBar({
    current: currentStep,
    total: totalSteps,
    width: progressBarWidth,
    phaseColor: phaseTheme.primary,
  });

  const testHint = hasTests ? "  " + chalk.bold("n/N") + " Test" : "";
  const footerText =
    " " +
    progressBar +
    "  " +
    chalk.bold("\u2190/\u2192") +
    " Step  " +
    chalk.bold("\u2191/\u2193") +
    " Scroll  " +
    chalk.bold("Tab") +
    " Focus  " +
    chalk.bold("Space") +
    " Play  " +
    chalk.bold("+/-") +
    " Speed  " +
    chalk.bold("r") +
    " Reset  " +
    chalk.bold("?") +
    " Help" +
    testHint +
    "  " +
    chalk.bold("q") +
    " Quit";

  // Sync previous-render tracking refs
  useEffect(() => {
    prevConsoleLenRef.current = consoleLen;
    prevLogLenRef.current = logLen;
    prevMemoryRef.current = memorySnapshot;
  });

  const isMicroActive = state.phase === "Microtasks";
  const isMacroActive = state.phase === "Macrotasks";
  const isStackActive = state.callStack.length > 0;

  // --- Render tree ---
  return h(
    Box,
    { flexDirection: "column", width: cols, height: rows },
    h(
      Box,
      {
        borderStyle: "single",
        borderColor: phaseTheme.primary,
        height: headerHeight,
      },
      h(Text, { bold: true, wrap: "truncate" }, headerText)
    ),

    h(
      Box,
      { flexDirection: "row", height: mainHeight },
      h(
        Box,
        {
          flexDirection: "column",
          width: leftColWidth,
          flexShrink: 0,
          flexGrow: 0,
        },
        h(Panel, {
          label: sourceLabel,
          color: sourceColor,
          focused: focusIndex === 0,
          lines: sourceContent,
          height: sourceHeight,
          width: leftColWidth,
          phaseColor: phaseTheme.primary,
        }),
        h(Panel, {
          label: "Memory",
          color: "magenta",
          focused: focusIndex === 1,
          lines: memoryContent,
          height: memoryHeight,
          width: leftColWidth,
          badge:
            state.memory.size > 0
              ? { text: String(state.memory.size), color: "magenta" }
              : null,
        }),
        h(Panel, {
          label: "Console Output",
          color: "yellow",
          focused: focusIndex === 2,
          lines: consoleContent,
          height: consoleHeight,
          width: leftColWidth,
        })
      ),

      h(
        Box,
        {
          flexDirection: "column",
          width: rightColWidth,
          flexShrink: 0,
          flexGrow: 0,
        },
        h(Panel, {
          label: "Call Stack",
          color: "red",
          focused: focusIndex === 4,
          lines: callStackContent,
          height: callStackHeight,
          width: rightColWidth,
          isActive: isStackActive,
          badge:
            state.callStack.length > 0
              ? { text: String(state.callStack.length), color: "red" }
              : null,
        }),
        h(
          Box,
          {
            flexDirection: "row",
            height: queuesHeight,
            flexShrink: 0,
            flexGrow: 0,
          },
          h(Panel, {
            label: "Microtask Queue",
            color: "cyan",
            focused: focusIndex === 5,
            lines: microContent,
            width: microQueueWidth,
            height: queuesHeight,
            isActive: isMicroActive,
            badge:
              state.microQueue.length > 0
                ? { text: String(state.microQueue.length), color: "cyan" }
                : null,
          }),
          h(Panel, {
            label: "Macrotask Queue",
            color: "redBright",
            focused: focusIndex === 6,
            lines: macroContent,
            width: macroQueueWidth,
            height: queuesHeight,
            isActive: isMacroActive,
            badge:
              state.macroQueue.length > 0
                ? { text: String(state.macroQueue.length), color: "redBright" }
                : null,
          })
        ),
        h(Panel, {
          label: "Event Log",
          color: "blue",
          focused: focusIndex === 3,
          lines: eventLogContent,
          height: eventLogHeight,
          width: rightColWidth,
          badge:
            state.log.length > 0
              ? { text: String(state.log.length), color: "blue" }
              : null,
        })
      )
    ),

    h(
      Box,
      { borderStyle: "single", borderColor: "gray", height: footerHeight },
      h(Text, { wrap: "truncate" }, footerText)
    ),

    showHelp && h(HelpOverlay, { width: cols, height: rows })
  );
}
