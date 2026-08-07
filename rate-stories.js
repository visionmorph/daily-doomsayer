(function initializeHumanCalibration() {
  "use strict";

  const STORAGE_KEY = "daily-doomsayer-human-calibration-v1";
  const articles = Array.isArray(window.DAILY_DOOMSAYER_ARTICLES)
    ? window.DAILY_DOOMSAYER_ARTICLES.filter(
        (article) => article?.title && article?.url,
      )
    : [];
  const site = window.DAILY_DOOMSAYER_SITE || {};
  const doomIndex = site.doomIndex || {};

  const elements = {
    workspace: document.querySelector("#calibration-workspace"),
    emptyState: document.querySelector("#empty-state"),
    progress: document.querySelector("#calibration-progress"),
    status: document.querySelector("#calibration-status"),
    exportButton: document.querySelector("#export-ratings"),
    title: document.querySelector("#story-title"),
    summary: document.querySelector("#story-summary"),
    summaryNote: document.querySelector("#summary-note"),
    feedStage: document.querySelector("#feed-rating-stage"),
    articleStage: document.querySelector("#article-rating-stage"),
    result: document.querySelector("#rating-result"),
    comparison: document.querySelector("#rating-comparison"),
    frame: document.querySelector("#story-frame"),
    openStory: document.querySelector("#open-story"),
    feedForm: document.querySelector("#feed-rating-form"),
    articleForm: document.querySelector("#article-rating-form"),
    feedSlider: document.querySelector("#feed-rating"),
    articleSlider: document.querySelector("#article-rating"),
    feedOutput: document.querySelector("#feed-rating-output"),
    articleOutput: document.querySelector("#article-rating-output"),
    feedValidation: document.querySelector('[data-validation-for="feed-rating"]'),
    nextButton: document.querySelector("#next-story"),
    scale: document.querySelector("#calibration-scale"),
    skipDialog: document.querySelector("#skip-dialog"),
    skipForm: document.querySelector("#skip-form"),
    cancelSkip: document.querySelector("#cancel-skip"),
  };

  let state = loadState();
  let currentIndex = firstUnfinishedIndex();

  function storyKey(article) {
    return String(article?.storyId || article?.url || "");
  }

  function articleIdentity(article) {
    return {
      storyId: article.storyId || null,
      title: article.title,
      url: article.url,
      source: article.source || "",
      published: article.published || "",
    };
  }

  function emptyState() {
    return {
      schemaVersion: "1.0",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ratings: {},
    };
  }

  function loadState() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY));

      if (saved?.schemaVersion === "1.0" && saved?.ratings) {
        return saved;
      }
    } catch {
      // A clean state is safer than preventing the tool from loading.
    }

    return emptyState();
  }

  function saveState() {
    state.updatedAt = new Date().toISOString();

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      elements.status.textContent =
        "Browser storage is unavailable. Export before closing this page.";
    }

    updateProgress();
  }

  function firstUnfinishedIndex() {
    const index = articles.findIndex((article) => {
      const record = state.ratings[storyKey(article)];
      return !record || !["rated", "skipped"].includes(record.status);
    });

    return index === -1 ? Math.max(articles.length - 1, 0) : index;
  }

  function completedCount() {
    return Object.values(state.ratings).filter((record) =>
      ["rated", "skipped"].includes(record.status),
    ).length;
  }

  function ratedCount() {
    return Object.values(state.ratings).filter(
      (record) => record.status === "rated",
    ).length;
  }

  function updateProgress() {
    const completed = Math.min(completedCount(), articles.length);
    const ordinal = articles.length ? Math.min(currentIndex + 1, articles.length) : 0;
    elements.progress.textContent = `Story ${ordinal} of ${articles.length} / ${completed} completed`;
    elements.exportButton.disabled = ratedCount() === 0;
  }

  function score(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric)
      ? Math.max(0, Math.min(100, numeric))
      : null;
  }

  function scoreText(value) {
    const numeric = score(value);
    return numeric === null ? "Unavailable" : numeric.toFixed(2);
  }

  function humanScore(value) {
    const numeric = score(value);
    return numeric === null ? null : Math.round(numeric);
  }

  function humanScoreText(value) {
    const numeric = humanScore(value);
    return numeric === null ? "Unavailable" : String(numeric);
  }

  function signedDifference(left, right, precision = 2) {
    const leftScore = score(left);
    const rightScore = score(right);

    if (leftScore === null || rightScore === null) {
      return "Unavailable";
    }

    const difference = leftScore - rightScore;
    return `${difference >= 0 ? "+" : ""}${difference.toFixed(precision)}`;
  }

  function setSlider(slider, output, value, interacted = false) {
    const normalized = humanScore(value) ?? 0;
    slider.value = String(normalized);
    slider.dataset.interacted = String(interacted);
    output.value = String(normalized);
    output.textContent = String(normalized);
  }

  function resetForm(form) {
    form.reset();
    form.querySelectorAll(".calibration-radio").forEach((label) => {
      label.classList.remove("is-selected");
    });
  }

  function selectedValue(form, name) {
    return form.elements[name]?.value || "";
  }

  function updateRadioStyle(event) {
    const input = event.target.closest('input[type="radio"]');

    if (!input) return;

    input.form
      ?.querySelectorAll(`input[name="${input.name}"]`)
      .forEach((radio) => {
        radio.closest(".calibration-radio")?.classList.toggle(
          "is-selected",
          radio.checked,
        );
      });
  }

  function currentArticle() {
    return articles[currentIndex] || null;
  }

  function currentRecord() {
    const article = currentArticle();
    return article ? state.ratings[storyKey(article)] : null;
  }

  function publicModel(article) {
    return {
      name: String(doomIndex.modelName || "DREAD").toUpperCase(),
      role: "PUBLIC",
      version: String(doomIndex.version || article.doomIndexVersion || "unknown"),
      formulaVersion: String(
        doomIndex.formulaVersion || article.doomIndexFormulaVersion || "unknown",
      ),
      score: score(article.doomIndex),
    };
  }

  function shadowModel(article) {
    return {
      name: String(doomIndex.modelName || "DREAD").toUpperCase(),
      role: "EXPERIMENTAL",
      version: String(
        doomIndex.shadow?.version || article.doomIndexV123ShadowVersion || "1.2.3",
      ),
      formulaVersion: String(
        doomIndex.shadow?.formulaVersion ||
          article.doomIndexV123ShadowFormulaVersion ||
          "unknown",
      ),
      score: score(article.doomIndexV123Shadow),
    };
  }

  function renderScale() {
    const scale = Array.isArray(doomIndex.severityScale)
      ? doomIndex.severityScale
      : [];

    elements.scale.replaceChildren();

    for (const band of scale) {
      const item = document.createElement("div");
      item.className = "calibration-scale-item";

      const heading = document.createElement("strong");
      heading.textContent = `${Number(band.minimum).toFixed(0)}–${Number(band.maximum).toFixed(2)} ${band.label}`;

      const description = document.createElement("span");
      description.textContent = band.description || "";

      item.append(heading, description);

      if (band.qualification) {
        const qualificationLabel = document.createElement("span");
        qualificationLabel.className = "calibration-scale-qualification-label";
        qualificationLabel.textContent = "Qualifies when";

        const qualification = document.createElement("span");
        qualification.textContent = band.qualification;
        item.append(qualificationLabel, qualification);
      }
      elements.scale.append(item);
    }
  }

  function renderStory() {
    const article = currentArticle();

    if (!article) {
      elements.workspace.hidden = true;
      elements.emptyState.hidden = false;
      elements.status.textContent = "No stories are available.";
      updateProgress();
      return;
    }

    elements.emptyState.hidden = true;
    elements.workspace.hidden = false;
    elements.title.textContent = article.title;

    const feedSummary = String(article.feedSummary || article.summary || "").trim();
    elements.summary.textContent = feedSummary;
    elements.summary.hidden = !feedSummary;
    elements.summaryNote.textContent = feedSummary
      ? "Rate this stage from the title and supplied feed summary only."
      : "No feed summary was supplied for this story. Rate this stage from the title only, or skip it.";

    elements.frame.src = article.url;
    elements.frame.title = `Article: ${article.title}`;
    elements.openStory.href = article.url;

    resetForm(elements.feedForm);
    resetForm(elements.articleForm);
    setSlider(elements.feedSlider, elements.feedOutput, 0, false);
    setSlider(elements.articleSlider, elements.articleOutput, 0, false);
    elements.feedValidation.hidden = true;
    elements.result.hidden = true;

    const record = currentRecord();

    if (record?.status === "in-progress" && record.feedRating) {
      showArticleStage(record);
      elements.status.textContent = "Feed rating saved locally. Complete the article-informed rating.";
    } else if (record?.status === "rated") {
      showResult(record);
    } else {
      elements.feedStage.hidden = false;
      elements.articleStage.hidden = true;
      elements.status.textContent = "";
    }

    updateProgress();
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function showArticleStage(record) {
    elements.feedStage.hidden = true;
    elements.articleStage.hidden = false;
    elements.result.hidden = true;
    setSlider(
      elements.articleSlider,
      elements.articleOutput,
      record.feedRating.score,
      true,
    );
    elements.articleForm.elements["reasoning"].value = "";

    const confidence = elements.articleForm.querySelector(
      `input[name="article-confidence"][value="${record.feedRating.confidence}"]`,
    );
    if (confidence) {
      confidence.checked = true;
      confidence.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function comparisonItem(label, value) {
    const item = document.createElement("div");
    item.className = "calibration-comparison-item";

    const heading = document.createElement("span");
    heading.textContent = label;

    const number = document.createElement("strong");
    number.className = "calibration-comparison-value";
    number.textContent = value;

    item.append(heading, number);
    return item;
  }

  function showResult(record) {
    elements.feedStage.hidden = true;
    elements.articleStage.hidden = true;
    elements.result.hidden = false;
    elements.comparison.replaceChildren();

    const publicDefinition = record.models.public;
    const shadowDefinition = record.models.shadow;

    elements.comparison.append(
      comparisonItem("Human / feed", humanScoreText(record.feedRating.score)),
      comparisonItem("Human / article", humanScoreText(record.articleRating.score)),
      comparisonItem(
        `${publicDefinition.name} ${publicDefinition.version} / ${publicDefinition.role}`,
        scoreText(publicDefinition.score),
      ),
      comparisonItem(
        `${shadowDefinition.name} ${shadowDefinition.version} / ${shadowDefinition.role}`,
        scoreText(shadowDefinition.score),
      ),
      comparisonItem(
        "Article context adjustment",
        signedDifference(record.articleRating.score, record.feedRating.score, 0),
      ),
      comparisonItem(
        "Experimental error after reading",
        signedDifference(shadowDefinition.score, record.articleRating.score),
      ),
    );

    elements.status.textContent = "Rating saved locally. Model scores are now revealed.";
    updateProgress();
  }

  function advanceStory() {
    const startIndex = currentIndex;

    for (let offset = 1; offset <= articles.length; offset += 1) {
      const candidateIndex = (startIndex + offset) % articles.length;
      const record = state.ratings[storyKey(articles[candidateIndex])];

      if (!record || !["rated", "skipped"].includes(record.status)) {
        currentIndex = candidateIndex;
        renderStory();
        return;
      }
    }

    elements.status.textContent = "Every available story has been completed. Export the ratings for analysis.";
    updateProgress();
  }

  function handleFeedSubmit(event) {
    event.preventDefault();

    if (elements.feedSlider.dataset.interacted !== "true") {
      elements.feedValidation.hidden = false;
      elements.feedSlider.focus();
      return;
    }

    if (!elements.feedForm.reportValidity()) return;

    const article = currentArticle();
    const key = storyKey(article);
    const now = new Date().toISOString();

    state.ratings[key] = {
      status: "in-progress",
      article: articleIdentity(article),
      feedEvidence: {
        summary: String(article.feedSummary || article.summary || ""),
        summaryAvailable: Boolean(article.feedSummary || article.summary),
      },
      feedRating: {
        score: humanScore(elements.feedSlider.value),
        confidence: Number(selectedValue(elements.feedForm, "feed-confidence")),
        reasoning: elements.feedForm.elements.reasoning.value.trim(),
        ratedAt: now,
      },
      models: {
        public: publicModel(article),
        shadow: shadowModel(article),
      },
      startedAt: state.ratings[key]?.startedAt || now,
      updatedAt: now,
    };

    saveState();
    showArticleStage(state.ratings[key]);
    elements.status.textContent = "Feed rating locked. Read the article, then confirm or revise it.";
    elements.articleStage.scrollIntoView({ behavior: "auto", block: "start" });
  }

  function handleArticleSubmit(event) {
    event.preventDefault();
    if (!elements.articleForm.reportValidity()) return;

    const article = currentArticle();
    const key = storyKey(article);
    const record = state.ratings[key];
    const now = new Date().toISOString();

    record.status = "rated";
    record.articleRating = {
      score: humanScore(elements.articleSlider.value),
      confidence: Number(
        selectedValue(elements.articleForm, "article-confidence"),
      ),
      reasoning: elements.articleForm.elements.reasoning.value.trim(),
      ratedAt: now,
    };
    record.contextAdjustment =
      record.articleRating.score - record.feedRating.score;
    record.completedAt = now;
    record.updatedAt = now;

    saveState();
    showResult(record);
    elements.result.scrollIntoView({ behavior: "auto", block: "start" });
  }

  function openSkipDialog() {
    elements.skipForm.reset();
    elements.skipDialog.showModal();
  }

  function handleSkipSubmit(event) {
    event.preventDefault();
    if (!elements.skipForm.reportValidity()) return;

    const article = currentArticle();
    const key = storyKey(article);
    const now = new Date().toISOString();
    const existing = state.ratings[key];

    state.ratings[key] = {
      ...existing,
      status: "skipped",
      article: articleIdentity(article),
      skip: {
        reason: selectedValue(elements.skipForm, "skip-reason"),
        details: elements.skipForm.elements["skip-details"].value.trim(),
        skippedAt: now,
      },
      models: existing?.models || {
        public: publicModel(article),
        shadow: shadowModel(article),
      },
      startedAt: existing?.startedAt || now,
      completedAt: now,
      updatedAt: now,
    };

    saveState();
    elements.skipDialog.close();
    advanceStory();
  }

  function exportRatings() {
    const records = Object.values(state.ratings);
    const payload = {
      schemaVersion: state.schemaVersion,
      exportedAt: new Date().toISOString(),
      calibrationMethod: {
        firstJudgment: "title-and-feed-summary",
        secondJudgment: "full-article-confirmation-or-revision",
        modelScoresHiddenUntil: "both-human-judgments-complete",
      },
      severityScale: doomIndex.severityScale || [],
      modelConfiguration: {
        public: {
          name: String(doomIndex.modelName || "DREAD").toUpperCase(),
          version: doomIndex.version || null,
          formulaVersion: doomIndex.formulaVersion || null,
        },
        shadow: doomIndex.shadow || null,
      },
      totals: {
        availableStories: articles.length,
        rated: records.filter((record) => record.status === "rated").length,
        skipped: records.filter((record) => record.status === "skipped").length,
        inProgress: records.filter((record) => record.status === "in-progress").length,
      },
      records,
    };

    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `dread-human-calibration-${date}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    elements.status.textContent = "Calibration ratings exported.";
  }

  function updateSlider(event) {
    const slider = event.currentTarget;
    const output = slider === elements.feedSlider
      ? elements.feedOutput
      : elements.articleOutput;
    slider.dataset.interacted = "true";
    output.value = String(Math.round(Number(slider.value)));
    output.textContent = String(Math.round(Number(slider.value)));

    if (slider === elements.feedSlider) {
      elements.feedValidation.hidden = true;
    }
  }

  elements.feedSlider.addEventListener("input", updateSlider);
  elements.feedSlider.addEventListener("change", updateSlider);
  elements.articleSlider.addEventListener("input", updateSlider);
  elements.articleSlider.addEventListener("change", updateSlider);
  elements.feedForm.addEventListener("change", updateRadioStyle);
  elements.articleForm.addEventListener("change", updateRadioStyle);
  elements.skipForm.addEventListener("change", updateRadioStyle);
  elements.feedForm.addEventListener("submit", handleFeedSubmit);
  elements.articleForm.addEventListener("submit", handleArticleSubmit);
  elements.nextButton.addEventListener("click", advanceStory);
  elements.exportButton.addEventListener("click", exportRatings);
  elements.skipForm.addEventListener("submit", handleSkipSubmit);
  elements.cancelSkip.addEventListener("click", () => elements.skipDialog.close());
  document.querySelectorAll("[data-skip-story]").forEach((button) => {
    button.addEventListener("click", openSkipDialog);
  });

  renderScale();
  renderStory();
})();
