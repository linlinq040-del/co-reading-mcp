import { buildCardCandidates, pickCard, sharedNoteIdSet } from "./card-logic.js";

const state = {
  books: [],
  chunks: [],
  annotations: [],
  bookId: null,
  chunkId: null,
  chunk: null,
  quote: "",
  quoteOffset: null,
  selectedQuote: "",
  selectedQuoteOffset: null,
  activeAnnotationId: null,
  cardCandidates: [],
  cardIndex: 0,
  lastFinish: null,
  toastTimer: null,
  refreshInFlight: false,
  composing: false,
  replyDrafts: {},
  spreadPage: 0,
  spreadPages: 1,
  spreadTouchX: null,
  pageTurning: false,
  spreadRanges: [],
};

const $ = (id) => document.getElementById(id);
const splashStartedAt = performance.now();
const authTokenKey = "co-reading-auth-token";
const urlToken = new URLSearchParams(location.search).get("token");
if (urlToken) {
  localStorage.setItem(authTokenKey, urlToken);
  history.replaceState(null, "", location.pathname);
}

async function api(path, options = {}) {
  const token = localStorage.getItem(authTokenKey);
  const response = await fetch(path, {
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Could not read file"));
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      let binary = "";
      const size = 0x8000;
      for (let index = 0; index < bytes.length; index += size) {
        binary += String.fromCharCode(...bytes.subarray(index, index + size));
      }
      resolve(btoa(binary));
    };
    reader.readAsArrayBuffer(file);
  });
}

function isMobileLayout() {
  return window.matchMedia("(max-width: 1366px)").matches;
}

function isBookSpreadLayout() {
  return window.matchMedia("(min-width: 981px) and (max-width: 1366px) and (orientation: landscape)").matches;
}

function scrollToPanel(selector) {
  if (!isMobileLayout()) return;
  requestAnimationFrame(() => {
    document.querySelector(selector)?.scrollIntoView({ block: "start", behavior: "smooth" });
  });
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  state.toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 2400);
}

function formatIdentity(author) {
  const value = String(author || "unknown").toLowerCase();
  if (value === "user" || value === "koshi") return "you";
  if (value === "claude") return "Ember";
  return value;
}

function replyClass(reply, root) {
  const sameAuthor = String(reply.author || "").toLowerCase() === String(root.author || "").toLowerCase();
  return sameAuthor ? "reply root-author" : "reply other-author";
}

function repliesFor(parentId, notes) {
  return notes.filter((item) => item.parentId === parentId);
}

function replyCount(parentId, notes, seen = new Set()) {
  if (seen.has(parentId)) return 0;
  seen.add(parentId);
  return repliesFor(parentId, notes).reduce((count, reply) => count + 1 + replyCount(reply.id, notes, seen), 0);
}

function renderReply(reply, root, notes, depth = 1, seen = new Set()) {
  if (!reply.id || seen.has(reply.id)) return "";
  const nextSeen = new Set(seen);
  nextSeen.add(reply.id);
  const children = repliesFor(reply.id, notes);
  const visibleDepth = Math.min(depth, 4);
  return `<div class="${replyClass(reply, root)}" style="--reply-depth: ${visibleDepth}">
    <p class="reply-body">${escapeHtml(reply.note)}</p>
    <div class="note-meta">${escapeHtml(formatIdentity(reply.author))} · ${escapeHtml(reply.kind || "reply")}</div>
    ${
      children.length
        ? `<div class="reply-children">${children
            .map((child) => renderReply(child, root, notes, depth + 1, nextSeen))
            .join("")}</div>`
        : ""
    }
  </div>`;
}

function renderThread(note, notes) {
  const replies = repliesFor(note.id, notes);
  const draft = state.replyDrafts[note.id] || "";
  return `<div class="thread">
    ${replies.map((reply) => renderReply(reply, note, notes, 1, new Set([note.id]))).join("")}
    <form class="reply-form" data-parent-id="${escapeHtml(note.id)}">
      <textarea rows="2" placeholder="Reply in this margin...">${escapeHtml(draft)}</textarea>
      <button type="submit" class="primary-button">Reply</button>
    </form>
  </div>`;
}

function renderInlineNote(note, notes) {
  const canDelete = note.author === "user" && ["open", "private", "draft"].includes(note.status || "open");
  return `<aside class="inline-note" data-note-id="${escapeHtml(note.id)}">
    ${canDelete ? `<button class="note-delete" type="button" data-delete-note="${escapeHtml(note.id)}">删除</button>` : ""}
    <p class="inline-note-kicker">${escapeHtml(formatIdentity(note.author))} · ${escapeHtml(note.kind || "note")}</p>
    <p class="note-body">${escapeHtml(note.note)}</p>
    ${renderThread(note, notes)}
  </aside>`;
}

function renderBooks() {
  $("books").innerHTML = state.books
    .map((book) => {
      const total = book.chunkCount || 0;
      const read = book.chunksRead || 0;
      const pct = total ? Math.round((read / total) * 100) : 0;
      const hue = Array.from(book.bookId || "book").reduce((sum, char) => sum + char.charCodeAt(0), 0) % 42;
      return `<div class="book-row ${book.bookId === state.bookId ? "active" : ""}">
        <button class="book" data-book="${escapeHtml(book.bookId)}">
          <span class="book-cover" style="--cover-hue:${hue}">
            <span class="book-cover-fallback">
              <span class="cover-title">${escapeHtml(book.title || book.bookId)}</span>
              <span class="cover-author">${escapeHtml(book.author || "共读书房")}</span>
            </span>
            ${book.coverUrl ? `<img src="${escapeHtml(book.coverUrl)}" alt="${escapeHtml(book.title || book.bookId)}封面" loading="lazy" />` : ""}
          </span>
          <span class="book-info">
            <span class="book-title">${escapeHtml(book.title || book.bookId)}</span>
            <span class="book-meta">${escapeHtml(book.author || "未知作者")}</span>
            <span class="book-progress-label">${pct ? `${pct}% 已读` : "尚未开始"}</span>
            <span class="progress"><span style="width: ${pct}%"></span></span>
          </span>
        </button>
        <button class="book-delete" data-delete-book="${escapeHtml(book.bookId)}" title="删除这本书">×</button>
      </div>`;
    })
    .join("");
  document.querySelectorAll(".book-cover img").forEach((image) => {
    image.addEventListener("error", () => image.remove(), { once: true });
  });
}

function renderChunks() {
  $("chunks").innerHTML = state.chunks
    .map(
      (chunk) => `<button class="chunk ${chunk.id === state.chunkId ? "active" : ""}" data-chunk="${escapeHtml(chunk.id)}">
        <span class="chunk-title">${escapeHtml(chunk.title)}</span>
        <span class="chunk-meta">${escapeHtml(chunk.id)} · ${chunk.read ? "read" : "unread"} · ${chunk.annotationCount || 0} notes</span>
      </button>`,
    )
    .join("");
}

function renderText() {
  if (!state.chunk) return;
  const text = state.chunk.text || "";
  const notes = state.annotations.filter((item) => item.chunkId === state.chunkId);
  const sharedIds = sharedNoteIdSet(notes);
  const highlights = [];
  const occupied = [];
  const rootNotes = notes
    .filter((item) => !item.parentId && item.quote)
    .sort((a, b) => {
      const left = Number.isInteger(a.quoteOffset) ? a.quoteOffset : text.indexOf(a.quote);
      const right = Number.isInteger(b.quoteOffset) ? b.quoteOffset : text.indexOf(b.quote);
      return left - right;
    });
  for (const note of rootNotes) {
    const quote = String(note.quote || "");
    const requestedOffset = Number(note.quoteOffset);
    const start =
      Number.isInteger(requestedOffset) && requestedOffset >= 0 && text.slice(requestedOffset, requestedOffset + quote.length) === quote
        ? requestedOffset
        : text.indexOf(quote);
    if (!quote || start < 0) continue;
    const end = start + quote.length;
    if (occupied.some((range) => start < range.end && end > range.start)) continue;
    occupied.push({ start, end });
    highlights.push({ start, end, note, shared: sharedIds.has(note.id) });
  }

  if (isBookSpreadLayout()) {
    renderMeasuredSpread(text, highlights);
    bindMarkActions();
    updatePageTurner();
    if (state.activeAnnotationId) showSpreadAnnotation(state.activeAnnotationId);
    else hideSpreadAnnotation();
    return;
  }

  let html = "";
  let cursor = 0;
  for (const highlight of highlights) {
    html += escapeHtml(text.slice(cursor, highlight.start));
    const quote = escapeHtml(text.slice(highlight.start, highlight.end));
    const bookmark = highlight.shared ? `<span class="shared-bookmark" title="这里有两个人的折痕。">此处有回声</span>` : "";
    html += `<mark class="${highlight.note.id === state.activeAnnotationId ? "active" : ""} ${highlight.shared ? "shared" : ""}" data-note-id="${escapeHtml(highlight.note.id)}" title="${escapeHtml(highlight.note.note)}">${quote}</mark>${bookmark}${
      highlight.note.id === state.activeAnnotationId && !isBookSpreadLayout() ? renderInlineNote(highlight.note, notes) : ""
    }`;
    cursor = highlight.end;
  }
  html += escapeHtml(text.slice(cursor));
  $("text").innerHTML = html;
  bindMarkActions();
  requestAnimationFrame(() => updatePageTurner());
  if (isBookSpreadLayout() && state.activeAnnotationId) {
    showSpreadAnnotation(state.activeAnnotationId);
  } else {
    hideSpreadAnnotation();
  }
}

function pageMetrics() {
  const textEl = $("text");
  const fontSize = 18;
  const lineHeight = fontSize * 1.86;
  return {
    innerWidth: Math.max(300, textEl.clientWidth / 2 - 118),
    maxLines: Math.max(8, Math.floor((textEl.clientHeight - 82) / lineHeight) - 1),
    fontSize,
  };
}

function measuredPageRanges(text) {
  if (!text) return [{ start: 0, end: 0 }];
  const { innerWidth, maxLines, fontSize } = pageMetrics();
  const canvas = measuredPageRanges.canvas || (measuredPageRanges.canvas = document.createElement("canvas"));
  const context = canvas.getContext("2d");
  context.font = `${fontSize}px "Songti SC", "STSong", serif`;
  const ranges = [];
  let start = 0;

  while (start < text.length) {
    let index = start;
    let lines = 1;
    let line = "";
    let lastComfortableBreak = -1;

    while (index < text.length) {
      const character = text[index];
      if (character === "\r") {
        index += 1;
        continue;
      }
      if (character === "\n") {
        lines += 1;
        line = "";
        lastComfortableBreak = index + 1;
        index += 1;
        if (lines > maxLines) break;
        continue;
      }

      const nextLine = line + character;
      if (context.measureText(nextLine).width > innerWidth && line) {
        lines += 1;
        line = character;
        if (lines > maxLines) break;
      } else {
        line = nextLine;
      }
      if (/[。！？；：.!?;:]|\s/.test(character)) lastComfortableBreak = index + 1;
      index += 1;
    }

    let end = Math.max(start + 1, index);
    if (index < text.length && lastComfortableBreak > start + 24 && end - lastComfortableBreak < 24) {
      end = lastComfortableBreak;
    }
    ranges.push({ start, end });
    start = end;
  }
  return ranges;
}

function renderPageSlice(text, range, highlights) {
  if (!range || range.start >= range.end) return `<p class="page-empty">本章至此，轻轻翻页继续。</p>`;
  const relevant = highlights.filter((item) => item.start < range.end && item.end > range.start);
  let html = "";
  let cursor = range.start;
  for (const highlight of relevant) {
    const markStart = Math.max(range.start, highlight.start);
    const markEnd = Math.min(range.end, highlight.end);
    if (markStart > cursor) html += escapeHtml(text.slice(cursor, markStart));
    const quote = escapeHtml(text.slice(markStart, markEnd));
    html += `<mark class="${highlight.note.id === state.activeAnnotationId ? "active" : ""} ${highlight.shared ? "shared" : ""}" data-note-id="${escapeHtml(highlight.note.id)}" title="${escapeHtml(highlight.note.note)}">${quote}</mark>`;
    cursor = markEnd;
  }
  if (cursor < range.end) html += escapeHtml(text.slice(cursor, range.end));
  return html;
}

function renderMeasuredSpread(text, highlights) {
  state.spreadRanges = measuredPageRanges(text);
  state.spreadPages = Math.max(1, Math.ceil(state.spreadRanges.length / 2));
  state.spreadPage = Math.min(state.spreadPage, state.spreadPages - 1);
  const leftIndex = state.spreadPage * 2;
  const left = state.spreadRanges[leftIndex] || { start: text.length, end: text.length };
  const right = state.spreadRanges[leftIndex + 1] || { start: text.length, end: text.length };
  $("text").innerHTML = `<div class="book-spread">
    <section class="book-page book-page-left" data-page-start="${left.start}">
      <div class="book-page-content">${renderPageSlice(text, left, highlights)}</div>
      <span class="leaf-number">${leftIndex + 1}</span>
    </section>
    <section class="book-page book-page-right" data-page-start="${right.start}">
      <div class="book-page-content">${renderPageSlice(text, right, highlights)}</div>
      <span class="leaf-number">${leftIndex + 2}</span>
    </section>
  </div>`;
}

function spreadPopover() {
  let popover = document.querySelector(".spread-annotation-popover");
  if (popover) return popover;
  popover = document.createElement("aside");
  popover.className = "spread-annotation-popover";
  popover.hidden = true;
  document.body.append(popover);
  popover.addEventListener("click", (event) => {
    if (event.target.closest("[data-close-spread-note]")) {
      state.activeAnnotationId = null;
      hideSpreadAnnotation();
      renderText();
      renderAnnotations();
    }
  });
  return popover;
}

function hideSpreadAnnotation() {
  const popover = document.querySelector(".spread-annotation-popover");
  if (popover) popover.hidden = true;
}

function updatePageTurner({ reset = false } = {}) {
  const text = $("text");
  const turner = $("page-turner");
  if (!text || !turner) return;
  const active = isBookSpreadLayout() && Boolean(state.chunk);
  turner.classList.toggle("active", active);
  if (!active) return;

  state.spreadPages = Math.max(1, Math.ceil(state.spreadRanges.length / 2));
  if (reset) {
    state.spreadPage = 0;
    renderText();
  } else {
    state.spreadPage = Math.min(state.spreadPage, state.spreadPages - 1);
  }
  $("page-number").textContent = `${state.spreadPage + 1} / ${state.spreadPages}`;
  $("page-prev").disabled = state.spreadPage <= 0 && !state.chunk?.prevId;
  $("page-next").disabled = state.spreadPage >= state.spreadPages - 1 && !state.chunk?.nextId;
}

function turnSpread(direction) {
  if (!isBookSpreadLayout() || state.pageTurning) return;
  const target = Math.max(0, Math.min(state.spreadPages - 1, state.spreadPage + direction));
  const boundaryChunkId = direction > 0 ? state.chunk?.nextId : state.chunk?.prevId;
  if (target === state.spreadPage && !boundaryChunkId) return;

  const text = $("text");
  state.pageTurning = true;
  text.classList.add(direction > 0 ? "turning-next" : "turning-prev");
  setTimeout(async () => {
    if (target !== state.spreadPage) {
      state.spreadPage = target;
      renderText();
      return;
    }
    try {
      await selectChunk(boundaryChunkId);
      requestAnimationFrame(() => {
        updatePageTurner({ reset: true });
        if (direction < 0) {
          state.spreadPage = Math.max(0, state.spreadPages - 1);
          renderText();
        }
      });
    } catch (error) {
      showError(error);
    }
  }, 245);
  setTimeout(() => {
    text.classList.remove("turning-next", "turning-prev");
    state.pageTurning = false;
  }, 620);
}

function showSpreadAnnotation(noteId) {
  if (!isBookSpreadLayout()) return;
  const note = state.annotations.find((item) => item.id === noteId);
  const mark = document.querySelector(`mark[data-note-id="${CSS.escape(noteId)}"]`);
  if (!note || !mark) return;

  const notes = state.annotations.filter((item) => item.chunkId === note.chunkId);
  const replies = repliesFor(note.id, notes);
  const popover = spreadPopover();
  popover.innerHTML = `
    <button type="button" class="spread-note-close" data-close-spread-note aria-label="关闭批注">×</button>
    <p class="inline-note-kicker">${escapeHtml(formatIdentity(note.author))} · ${escapeHtml(note.kind || "note")}</p>
    <p class="spread-note-quote">${escapeHtml(note.quote || "")}</p>
    <p class="note-body">${escapeHtml(note.note || "")}</p>
    ${replies.length ? `<div class="spread-note-replies">${replies.map((reply) => renderReply(reply, note, notes, 1, new Set([note.id]))).join("")}</div>` : ""}
  `;
  popover.hidden = false;

  requestAnimationFrame(() => {
    const markRect = mark.getBoundingClientRect();
    const cardRect = popover.getBoundingClientRect();
    const margin = 18;
    const left = Math.min(
      window.innerWidth - cardRect.width - margin,
      Math.max(margin, markRect.left + markRect.width / 2 - cardRect.width / 2),
    );
    const below = markRect.bottom + 12;
    const top = below + cardRect.height <= window.innerHeight - margin
      ? below
      : Math.max(margin, markRect.top - cardRect.height - 12);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  });
}

function bindMarkActions() {
  document.querySelectorAll("mark[data-note-id]").forEach((mark) => {
    const open = (event) => {
      event.stopPropagation();
      activateAnnotation(mark.dataset.noteId, { scroll: true });
    };
    mark.addEventListener("click", open);
    mark.addEventListener("touchend", open);
  });
}

function renderAnnotations() {
  const notes = state.annotations.filter((item) => item.chunkId === state.chunkId);
  const roots = notes.filter((item) => !item.parentId);
  const openCount = state.annotations.filter((item) => item.author === "user" && (item.status || "open") === "open")
    .length;

  $("margins").innerHTML = roots
    .map((note) => {
      const replies = replyCount(note.id, notes);
      const expanded = note.id === state.activeAnnotationId;
      const isShared = sharedNoteIdSet(notes).has(note.id);
      const canDelete = note.author === "user" && ["open", "private", "draft"].includes(note.status || "open");
      return `<article class="note-card ${(note.status || "") === "open" ? "open" : ""} ${expanded ? "active" : ""}" data-note-id="${escapeHtml(note.id)}" tabindex="0">
        ${canDelete ? `<button class="note-delete" type="button" data-delete-note="${escapeHtml(note.id)}">删除</button>` : ""}
        ${isShared ? `<p class="shared-line">这里有两个人的折痕。</p>` : ""}
        <p class="note-quote">${escapeHtml(note.quote)}</p>
        <p class="note-body">${escapeHtml(note.note)}</p>
        <div class="note-meta">${escapeHtml(formatIdentity(note.author))} · ${escapeHtml(note.kind || "note")} · ${escapeHtml(note.status || "published")}${replies ? ` · ${replies} replies` : ""}</div>
        ${
          expanded
            ? renderThread(note, notes)
            : ""
        }
      </article>`;
    })
    .join("");

  $("submit-notes").disabled = openCount === 0;
  $("submit-notes").textContent = openCount ? `发送 ${openCount} 条给 Ember` : "发送给 Ember";
  $("status").textContent = openCount
    ? `${openCount} 条私人笔记正在等待发送。`
    : "你的笔记会先安静地留在这里。";
  $("tools-count").textContent = String(openCount);
  $("tools-count").hidden = openCount === 0;
}

function setReadingTools(open) {
  $("reading-tools").classList.toggle("is-open", open);
  $("reading-tools").setAttribute("aria-hidden", String(!open));
  $("tools-toggle").setAttribute("aria-expanded", String(open));
  $("tools-toggle").classList.toggle("is-hidden", open);
}

function currentBook() {
  return state.books.find((item) => item.bookId === state.bookId) || {};
}

function currentChunkMeta() {
  return state.chunks.find((item) => item.id === state.chunkId) || state.chunk?.chunk || {};
}

function refreshCards({ finish = null, show = false } = {}) {
  const chunkAnnotations = state.annotations.filter((item) => item.chunkId === state.chunkId);
  state.cardCandidates = buildCardCandidates({
    book: currentBook(),
    chunk: { ...currentChunkMeta(), text: state.chunk?.text || "" },
    annotations: chunkAnnotations,
    finish,
  });
  if (state.cardIndex >= state.cardCandidates.length) state.cardIndex = 0;
  $("show-card").disabled = state.cardCandidates.length === 0;
  $("show-card").textContent = state.cardCandidates.length ? `Cards ${state.cardCandidates.length}` : "Cards";
  if (show && state.cardCandidates.length) {
    openCardPanel();
  } else {
    renderCardPanel();
  }
}

function renderCardPanel() {
  const card = pickCard(state.cardCandidates, state.cardIndex);
  $("card-panel").hidden = !card || $("card-panel").hidden;
  if (!card) {
    $("card-preview").innerHTML = "";
    return;
  }
  $("card-preview").innerHTML = renderReadingCard(card);
}

function seededRandom(seed) {
  let value = (Number(seed) || 1) >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}

function readingCardArt(card) {
  const random = seededRandom(card.artSeed || 1);
  if (card.art === "ripple") {
    const centers = [
      [25 + random() * 18, 20 + random() * 18],
      [58 + random() * 18, 48 + random() * 18],
      [22 + random() * 14, 72 + random() * 12],
    ];
    const circles = centers
      .flatMap(([cx, cy], groupIndex) =>
        Array.from({ length: groupIndex === 1 ? 4 : 3 }, (_, index) => {
          const radius = 8 + index * (6 + random() * 3) + random() * 2;
          const opacity = 0.035 + random() * 0.06;
          return `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${radius.toFixed(2)}" opacity="${opacity.toFixed(3)}" />`;
        }),
      )
      .join("");
    return `<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="0.36">${circles}</g></svg>`;
  }
  if (card.art === "stardust") {
    const dots = Array.from({ length: 64 }, () => {
      const cx = 7 + random() * 86;
      const cy = 8 + random() * 80;
      const radius = 0.08 + random() * 0.24;
      const opacity = 0.18 + random() * 0.42;
      return `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${radius.toFixed(2)}" opacity="${opacity.toFixed(3)}" />`;
    }).join("");
    const bright = Array.from({ length: 7 }, () => {
      const cx = 12 + random() * 76;
      const cy = 12 + random() * 72;
      const opacity = 0.22 + random() * 0.26;
      return `<path d="M ${(cx - 0.9).toFixed(2)} ${cy.toFixed(2)} L ${(cx + 0.9).toFixed(2)} ${cy.toFixed(2)} M ${cx.toFixed(2)} ${(cy - 0.9).toFixed(2)} L ${cx.toFixed(2)} ${(cy + 0.9).toFixed(2)}" opacity="${opacity.toFixed(3)}" />`;
    }).join("");
    const lines = Array.from({ length: 5 }, () => {
      const x1 = 8 + random() * 84;
      const y1 = 10 + random() * 76;
      const x2 = x1 + (random() - 0.5) * 12;
      const y2 = y1 + (random() - 0.5) * 12;
      return `<path d="M ${x1.toFixed(2)} ${y1.toFixed(2)} L ${x2.toFixed(2)} ${y2.toFixed(2)}" opacity="0.07" />`;
    }).join("");
    return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><g fill="currentColor">${dots}</g><g fill="none" stroke="currentColor" stroke-width="0.14">${lines}${bright}</g></svg>`;
  }
  const lines = Array.from({ length: 14 }, () => {
    const x = 8 + random() * 84;
    const drift = (random() - 0.5) * 10;
    const opacity = 0.06 + random() * 0.14;
    return `<path d="M ${x.toFixed(2)} 3 C ${(x + drift).toFixed(2)} 30 ${(x - drift).toFixed(2)} 62 ${x.toFixed(2)} 97" opacity="${opacity.toFixed(3)}" />`;
  }).join("");
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="0.32">${lines}</g></svg>`;
}

function renderReadingCard(card) {
  return `<article class="ritual-card ${escapeHtml(card.variant)} art-${escapeHtml(card.art || "fold")} ${escapeHtml(cardSizeClass(card))}">
    <div class="card-art">${readingCardArt(card)}</div>
    <div class="card-content">
      <p class="card-kicker">${escapeHtml(card.kicker)}</p>
      <h3>${escapeHtml(card.title)}</h3>
      <p class="card-subtitle">${escapeHtml(card.subtitle)}</p>
      <blockquote>${escapeHtml(card.quote)}</blockquote>
      <div class="card-voices ${card.rightText ? "" : "single"}">
        <section>
          <span>${escapeHtml(card.leftLabel)}</span>
          <p>${escapeHtml(card.leftText)}</p>
        </section>
        ${
          card.rightText
            ? `<section>
                <span>${escapeHtml(card.rightLabel)}</span>
                <p>${escapeHtml(card.rightText)}</p>
              </section>`
            : ""
        }
      </div>
      <footer>${escapeHtml(card.footer)}</footer>
    </div>
  </article>`;
}

function cardSizeClass(card) {
  const totalLength = [card.quote, card.leftText, card.rightText, card.note]
    .filter(Boolean)
    .join("")
    .length;
  if (totalLength < 120) return "card-compact";
  if (totalLength > 360) return "card-tall";
  return "card-standard";
}

function openCardPanel() {
  if (!state.cardCandidates.length) return;
  $("card-panel").hidden = false;
  renderCardPanel();
}

function updateSelectionAction() {
  const selection = window.getSelection();
  const details = selectionDetails(selection);
  state.selectedQuote = details?.quote || "";
  state.selectedQuoteOffset = details?.quoteOffset ?? null;
  $("note-selection").disabled = !state.selectedQuote || !state.bookId || !state.chunkId;
}

function elementForNode(node) {
  return node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index <= haystack.length) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + Math.max(needle.length, 1);
  }
  return count;
}

function findOccurrence(haystack, needle, occurrence) {
  let index = -1;
  let from = 0;
  for (let current = 0; current <= occurrence; current += 1) {
    index = haystack.indexOf(needle, from);
    if (index === -1) return -1;
    from = index + Math.max(needle.length, 1);
  }
  return index;
}

function selectionDetails(selection) {
  if (!selection || selection.rangeCount === 0 || !state.chunk?.text) return null;
  const rawQuote = selection.toString();
  const quote = rawQuote.trim();
  if (!quote) return null;

  const range = selection.getRangeAt(0);
  const textEl = $("text");
  const startEl = elementForNode(range.startContainer);
  const endEl = elementForNode(range.endContainer);
  if (!startEl || !endEl) return null;
  if (!textEl.contains(range.commonAncestorContainer) || !textEl.contains(startEl) || !textEl.contains(endEl)) return null;
  if (startEl.closest(".inline-note, .shared-bookmark") || endEl.closest(".inline-note, .shared-bookmark")) return null;

  const page = startEl.closest(".book-page");
  const pageContent = startEl.closest(".book-page-content") || textEl;
  const prefixRange = range.cloneRange();
  prefixRange.selectNodeContents(pageContent);
  prefixRange.setEnd(range.startContainer, range.startOffset);
  const pageStart = Number(page?.dataset.pageStart || 0);
  const leadingTrim = Math.max(0, rawQuote.indexOf(quote));
  const directOffset = pageStart + prefixRange.toString().length + leadingTrim;
  const occurrence = countOccurrences(prefixRange.toString(), quote);
  const fallbackOffset = findOccurrence(state.chunk.text, quote, occurrence);
  const quoteOffset = state.chunk.text.slice(directOffset, directOffset + quote.length) === quote
    ? directOffset
    : fallbackOffset;
  return {
    quote,
    quoteOffset: quoteOffset >= 0 ? quoteOffset : null,
  };
}

async function loadBooks() {
  state.books = await api("/api/books");
  renderBooks();
}

async function selectBook(bookId) {
  state.bookId = bookId;
  state.chunkId = null;
  state.chunk = null;
  state.activeAnnotationId = null;
  state.replyDrafts = {};
  state.chunks = await api(`/api/books/${encodeURIComponent(bookId)}/chunks`);
  state.annotations = await api(`/api/annotations?bookId=${encodeURIComponent(bookId)}`);
  const book = state.books.find((item) => item.bookId === bookId);
  $("book-meta").textContent = book?.author || "Unknown author";
  $("book-title").textContent = book?.title || bookId;
  $("chunk-file").textContent = "No chapter selected";
  $("chunk-title").textContent = "Open a chapter to start reading";
  $("text").innerHTML = `<p class="empty">选择一个章节。长按选中文字，就能给 Ember 留下批注。</p>`;
  $("mark-read").disabled = true;
  $("continue-reading").disabled = false;
  document.body.classList.add("has-book");
  document.body.classList.remove("has-chunk");
  renderBooks();
  renderChunks();
  renderAnnotations();
  scrollToPanel(".chapters");
}

function clearBookSelection() {
  state.bookId = null;
  state.chunkId = null;
  state.chunk = null;
  state.annotations = [];
  state.chunks = [];
  state.activeAnnotationId = null;
  state.cardCandidates = [];
  state.replyDrafts = {};
  $("book-meta").textContent = "Choose a book";
  $("book-title").textContent = "Reading shelf";
  $("chunk-file").textContent = "No chapter selected";
  $("chunk-title").textContent = "Open a chapter to start reading";
  $("text").innerHTML = `<p class="empty">先选择一本书和章节。长按选中文字，就能给 Ember 留下批注。</p>`;
  $("text").classList.remove("short-spread");
  $("mark-read").disabled = true;
  $("continue-reading").disabled = true;
  $("show-card").disabled = true;
  document.body.classList.remove("has-book", "has-chunk");
  renderChunks();
  renderAnnotations();
}

async function deleteBookFromShelf(bookId) {
  const book = state.books.find((item) => item.bookId === bookId);
  const label = book?.title || bookId;
  if (!confirm(`Delete "${label}" from this library?\n\nThe files and related notes will be archived under data/trash.`)) return;

  const result = await api(`/api/books/${encodeURIComponent(bookId)}`, { method: "DELETE" });
  $("status").textContent = result.message || `Deleted ${label}.`;
  await loadBooks();
  if (state.bookId === bookId) clearBookSelection();
  renderBooks();
}

async function selectChunk(chunkId) {
  state.chunkId = chunkId;
  state.spreadPage = 0;
  state.activeAnnotationId = null;
  state.chunk = await api(`/api/books/${encodeURIComponent(state.bookId)}/chunks/${encodeURIComponent(chunkId)}`);
  state.lastFinish = null;
  $("chunk-file").textContent = state.chunk.chunk.id;
  $("chunk-title").textContent = state.chunk.chunk.title;
  $("mark-read").disabled = false;
  $("continue-reading").disabled = false;
  document.body.classList.add("has-chunk");
  renderChunks();
  renderText();
  renderAnnotations();
  refreshCards();
  requestAnimationFrame(() => updatePageTurner({ reset: true }));
  scrollToPanel(".reader");
}

function openNoteForm(quote) {
  state.quote = quote.trim();
  state.quoteOffset = state.selectedQuote === state.quote ? state.selectedQuoteOffset : null;
  if (!state.bookId || !state.chunkId || !state.quote) return;
  $("quote-preview").textContent = state.quote;
  $("note").value = "";
  $("note-form").hidden = false;
  $("note").focus();
}

function activateAnnotation(noteId, { scroll = false } = {}) {
  state.activeAnnotationId = noteId;
  renderText();
  renderAnnotations();
  if (isBookSpreadLayout()) showSpreadAnnotation(noteId);
  if (scroll) {
    document.querySelector(`.inline-note[data-note-id="${CSS.escape(noteId)}"], .note-card[data-note-id="${CSS.escape(noteId)}"]`)?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }
}

async function deletePrivateNote(noteId) {
  const note = state.annotations.find((item) => item.id === noteId);
  if (!note) return;
  if (!confirm(`删除这条尚未发送的批注？\n\n${note.note || ""}`)) return;
  await api(`/api/annotations/${encodeURIComponent(noteId)}`, { method: "DELETE" });
  if (state.activeAnnotationId === noteId) state.activeAnnotationId = null;
  await refreshCurrent({ force: true });
  showToast("这条私人批注已删除");
}

function isEditingDraft() {
  const active = document.activeElement;
  return Boolean(
    state.composing ||
      active?.matches?.("textarea, input") ||
      active?.closest?.(".reply-form, .note-form"),
  );
}

async function refreshCurrent({ force = false } = {}) {
  if (state.refreshInFlight) return;
  if (!force && isEditingDraft()) return;
  state.refreshInFlight = true;
  try {
    await loadBooks();
    if (state.bookId) {
      if (!state.books.some((book) => book.bookId === state.bookId)) {
        clearBookSelection();
        $("status").textContent = "This book was deleted from the active library.";
        return;
      }
      state.chunks = await api(`/api/books/${encodeURIComponent(state.bookId)}/chunks`);
      state.annotations = await api(`/api/annotations?bookId=${encodeURIComponent(state.bookId)}`);
      renderBooks();
      renderChunks();
      renderText();
      renderAnnotations();
      refreshCards();
    }
  } finally {
    state.refreshInFlight = false;
  }
}

$("books").addEventListener("click", (event) => {
  const deleteButton = event.target.closest("[data-delete-book]");
  if (deleteButton) {
    deleteBookFromShelf(deleteButton.dataset.deleteBook).catch(showError);
    return;
  }
  const button = event.target.closest("[data-book]");
  if (button) selectBook(button.dataset.book).catch(showError);
});

$("chunks").addEventListener("click", (event) => {
  const button = event.target.closest("[data-chunk]");
  if (button) selectChunk(button.dataset.chunk).catch(showError);
});

$("text").addEventListener("mouseup", () => {
  updateSelectionAction();
});

$("text").addEventListener("touchend", () => {
  setTimeout(updateSelectionAction, 80);
});

$("text").addEventListener("touchstart", (event) => {
  if (!isBookSpreadLayout() || event.touches.length !== 1) return;
  state.spreadTouchX = event.touches[0].clientX;
}, { passive: true });

$("text").addEventListener("touchend", (event) => {
  if (!isBookSpreadLayout() || state.spreadTouchX === null || !event.changedTouches.length) return;
  const distance = event.changedTouches[0].clientX - state.spreadTouchX;
  state.spreadTouchX = null;
  if (Math.abs(distance) < 56 || window.getSelection()?.toString()) return;
  turnSpread(distance < 0 ? 1 : -1);
}, { passive: true });

$("text").addEventListener("click", (event) => {
  const deleteButton = event.target.closest("[data-delete-note]");
  if (deleteButton) {
    event.stopPropagation();
    deletePrivateNote(deleteButton.dataset.deleteNote).catch(showError);
    return;
  }
  const mark = event.target.closest("mark[data-note-id]");
  if (mark) activateAnnotation(mark.dataset.noteId, { scroll: true });
});

document.addEventListener("selectionchange", updateSelectionAction);

$("cancel-note").addEventListener("click", () => {
  $("note-form").hidden = true;
});

$("note-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const note = $("note").value.trim();
  if (!note) return;
  await api("/api/annotations", {
    method: "POST",
    body: {
      bookId: state.bookId,
      chunkId: state.chunkId,
      quote: state.quote,
      quoteOffset: state.quoteOffset,
      note,
      kind: "note",
    },
  });
  $("note-form").hidden = true;
  window.getSelection()?.removeAllRanges();
  updateSelectionAction();
  await refreshCurrent({ force: true });
});

$("note-selection").addEventListener("click", () => {
  const quote = state.selectedQuote || window.getSelection()?.toString() || "";
  openNoteForm(quote);
  if (quote) setReadingTools(false);
});

$("margins").addEventListener("click", (event) => {
  const deleteButton = event.target.closest("[data-delete-note]");
  if (deleteButton) {
    event.stopPropagation();
    deletePrivateNote(deleteButton.dataset.deleteNote).catch(showError);
    return;
  }
  if (event.target.closest("textarea, button")) return;
  const card = event.target.closest(".note-card[data-note-id]");
  if (card) activateAnnotation(card.dataset.noteId);
});

document.addEventListener("submit", async (event) => {
  const form = event.target.closest(".reply-form");
  if (!form) return;
  event.preventDefault();
  const textarea = form.querySelector("textarea");
  const note = textarea.value.trim();
  if (!note) return;
  await api("/api/replies", {
    method: "POST",
    body: {
      parentId: form.dataset.parentId,
      note,
      author: "user",
      kind: "reply",
    },
  });
  textarea.value = "";
  delete state.replyDrafts[form.dataset.parentId];
  await refreshCurrent({ force: true });
});

document.addEventListener("input", (event) => {
  const textarea = event.target.closest("textarea");
  const form = event.target.closest(".reply-form");
  if (!textarea || !form) return;
  state.replyDrafts[form.dataset.parentId] = textarea.value;
});

document.addEventListener("compositionstart", (event) => {
  if (!event.target.closest?.(".reply-form, .note-form")) return;
  state.composing = true;
});

document.addEventListener("compositionend", (event) => {
  if (!event.target.closest?.(".reply-form, .note-form")) return;
  state.composing = false;
});

$("submit-notes").addEventListener("click", async () => {
  const result = await api("/api/submit-notes", {
    method: "POST",
    body: {
      bookId: state.bookId,
      sessionId: "reader",
      contextMode: "chunk-once-per-session",
    },
  });
  await refreshCurrent({ force: true });
  $("status").textContent = result.submissionId
    ? `已把 ${result.count} 条笔记发送给 Ember。`
    : result.message || "No private notes to share.";
  setReadingTools(false);
});

$("mark-read").addEventListener("click", async () => {
  const result = await api("/api/mark-read", {
    method: "POST",
    body: { bookId: state.bookId, chunkId: state.chunkId },
  });
  state.lastFinish = result.finish || null;
  await refreshCurrent({ force: true });
  refreshCards({ finish: state.lastFinish, show: Boolean(state.lastFinish) });
  if (!state.lastFinish && state.cardCandidates.some((card) => card.source === "shared")) {
    showToast("收获了一枚回声书签");
  }
});

$("continue-reading").addEventListener("click", async () => {
  if (!state.bookId) return;
  const next = await api(`/api/continue?bookId=${encodeURIComponent(state.bookId)}`);
  const chunkId = next?.chunk?.chunk?.id || next?.chunk?.chunkId || next?.chunk?.id;
  if (!chunkId) {
    $("status").textContent = next?.message || "Nothing left to continue.";
    return;
  }
  await selectChunk(chunkId);
});

$("refresh").addEventListener("click", () => refreshCurrent({ force: true }).catch(showError));

$("tools-toggle").addEventListener("click", () => setReadingTools(true));
$("tools-close").addEventListener("click", () => setReadingTools(false));

$("page-prev").addEventListener("click", () => turnSpread(-1));
$("page-next").addEventListener("click", () => turnSpread(1));

window.addEventListener("resize", () => {
  requestAnimationFrame(() => updatePageTurner({ reset: true }));
});

$("back-to-library").addEventListener("click", () => {
  document.body.classList.remove("has-book", "has-chunk");
  window.scrollTo({ top: 0, behavior: "smooth" });
});

$("back-to-chapters").addEventListener("click", () => {
  document.body.classList.remove("has-chunk");
  document.body.classList.add("has-book");
  window.scrollTo({ top: 0, behavior: "smooth" });
});

$("show-card").addEventListener("click", openCardPanel);

$("card-close").addEventListener("click", () => {
  $("card-panel").hidden = true;
});

$("card-random").addEventListener("click", () => {
  if (!state.cardCandidates.length) return;
  state.cardIndex = (state.cardIndex + 1) % state.cardCandidates.length;
  renderCardPanel();
});

$("import-book").addEventListener("click", () => {
  $("import-file").click();
});

$("import-file").addEventListener("change", async (event) => {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  $("import-book").disabled = true;
  try {
    const imported = [];
    for (const file of files) {
      $("status").textContent = `Importing ${file.name}...`;
      const manifest = await api("/api/import", {
        method: "POST",
        body: {
          filename: file.name,
          dataBase64: await fileToBase64(file),
        },
      });
      imported.push(manifest);
    }
    $("status").textContent = files.length === 1 ? `Imported ${files[0].name}.` : `Imported ${files.length} books.`;
    await loadBooks();
    renderBooks();
    if (imported.length === 1 && imported[0]?.bookId) {
      await selectBook(imported[0].bookId);
    }
  } catch (error) {
    showError(error);
  } finally {
    $("import-book").disabled = false;
    event.target.value = "";
  }
});

function showError(error) {
  $("status").textContent = error.message || String(error);
}

function dismissSplash() {
  const splash = $("splash");
  if (!splash || splash.classList.contains("leaving")) return;
  const wait = Math.max(0, 900 - (performance.now() - splashStartedAt));
  setTimeout(() => {
    splash.classList.add("leaving");
    splash.addEventListener("transitionend", () => splash.remove(), { once: true });
  }, wait);
}

loadBooks().catch(showError).finally(dismissSplash);
setTimeout(dismissSplash, 8000);
setInterval(() => {
  if (document.hidden) return;
  refreshCurrent().catch(showError);
}, 5000);
