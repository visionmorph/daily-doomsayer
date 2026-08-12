(function initializeHumanCalibration() {
  "use strict";

  const reviewMode =
    new URLSearchParams(window.location.search).get("mode") === "blind-review";
  const reviewQueue = window.DAILY_DOOMSAYER_REVIEW_QUEUE || {};
  const reviewArticles = Array.isArray(reviewQueue.records)
    ? reviewQueue.records.map((record) => ({
        benchmarkId: record.benchmarkId,
        storyId: record.article?.storyId || null,
        title: record.article?.title || "",
        url: record.article?.url || "",
        source: record.article?.source || "",
        published: record.article?.published || "",
        feedSummary: record.feedSummary || "",
      }))
    : [];
  const sourceArticles = reviewMode
    ? reviewArticles
    : window.DAILY_DOOMSAYER_ARTICLES;
  const STORAGE_KEY = reviewMode
    ? `daily-doomsayer-blind-review-${reviewQueue.queueFingerprint || "v1"}`
    : "daily-doomsayer-human-calibration-v1";
  const articles = Array.isArray(sourceArticles)
    ? sourceArticles.filter((article) => article?.title && article?.url)
    : [];
  const site = reviewMode
    ? { doomIndex: { severityScale: reviewQueue.severityScale || [] } }
    : window.DAILY_DOOMSAYER_SITE || {};
  const doomIndex = site.doomIndex || {};
  const guidance = window.DAILY_DOOMSAYER_CALIBRATION_GUIDANCE;
  const FEED_SUMMARY_CHARACTER_LIMIT = 360;
  const NO_HARM_DEPENDENT_FACTORS = new Set([
    "reach",
    "reversibility",
    "containment",
    "recurrence",
    "vulnerability",
  ]);

  if (!guidance?.factors || typeof guidance.recommendation !== "function") {
    throw new Error("The human calibration guidance could not be loaded.");
  }

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
    articleValidation: document.querySelector(
      '[data-validation-for="article-rating"]',
    ),
    nextButton: document.querySelector("#next-story"),
    feedScale: document.querySelector("#feed-calibration-scale"),
    articleScale: document.querySelector("#article-calibration-scale"),
    skipDialog: document.querySelector("#skip-dialog"),
    skipForm: document.querySelector("#skip-form"),
    cancelSkip: document.querySelector("#cancel-skip"),
  };

  const stages = {
    feed: {
      id: "feed",
      form: elements.feedForm,
      evidenceGroups: document.querySelector("#feed-evidence-groups"),
      recommendation: document.querySelector("#feed-recommendation"),
      recommendationOutput: document.querySelector("#feed-recommendation-output"),
      recommendationReasoning: document.querySelector(
        "#feed-recommendation-reasoning",
      ),
      manualRating: document.querySelector("#feed-manual-rating"),
      slider: elements.feedSlider,
      output: elements.feedOutput,
      scale: elements.feedScale,
      validation: elements.feedValidation,
      ratingChoiceName: "feed-rating-choice",
      confidenceName: "feed-confidence",
      currentRecommendation: null,
    },
    article: {
      id: "article",
      form: elements.articleForm,
      evidenceGroups: document.querySelector("#article-evidence-groups"),
      recommendation: document.querySelector("#article-recommendation"),
      recommendationOutput: document.querySelector(
        "#article-recommendation-output",
      ),
      recommendationReasoning: document.querySelector(
        "#article-recommendation-reasoning",
      ),
      manualRating: document.querySelector("#article-manual-rating"),
      slider: elements.articleSlider,
      output: elements.articleOutput,
      scale: elements.articleScale,
      validation: elements.articleValidation,
      ratingChoiceName: "article-rating-choice",
      confidenceName: "article-confidence",
      currentRecommendation: null,
    },
  };

  let state = loadState();
  let currentIndex = firstUnfinishedIndex();

  function storyKey(article) {
    return String(article?.storyId || article?.url || "");
  }

  function articleIdentity(article) {
    return {
      benchmarkId: article.benchmarkId || null,
      storyId: article.storyId || null,
      title: article.title,
      url: article.url,
      source: article.source || "",
      published: article.published || "",
    };
  }

  function feedSummaryForCalibration(article) {
    const summary = String(article.feedSummary || article.summary || "").trim();

    if (summary.length <= FEED_SUMMARY_CHARACTER_LIMIT) {
      return summary;
    }

    const clipped = summary
      .slice(0, FEED_SUMMARY_CHARACTER_LIMIT - 1)
      .trimEnd();
    const finalSpace = clipped.lastIndexOf(" ");
    const truncated = finalSpace > 0 ? clipped.slice(0, finalSpace) : clipped;

    return `${truncated.trimEnd()}…`;
  }

  function modelScoringInput(article) {
    const productionSummary = String(article.doomIndexInputSummary || "").trim();
    const feedSummary = feedSummaryForCalibration(article);
    const coverageSources = Number(
      article.doomIndexCoverageSources || article.coverageSources || 1,
    );

    return {
      title: article.title,
      summary: productionSummary || feedSummary,
      coverageSources:
        Number.isFinite(coverageSources) && coverageSources > 0
          ? coverageSources
          : 1,
      provenance: productionSummary ? "production" : "feed-fallback",
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
      return (
        !record ||
        !["rated", "skipped"].includes(record.status) ||
        requiresGuidedRerating(record)
      );
    });

    return index === -1 ? Math.max(articles.length - 1, 0) : index;
  }

  function completedCount() {
    return Object.values(state.ratings).filter(
      (record) =>
        ["rated", "skipped"].includes(record.status) &&
        !requiresGuidedRerating(record),
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

  function sliderOutputText(slider, value) {
    const normalized = humanScore(value) ?? 0;

    if (slider === elements.feedSlider) {
      const band = severityBandForScore(normalized);
      return `${band?.label || "UNCLASSIFIED"} ${normalized}`;
    }

    return String(normalized);
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
    output.value = sliderOutputText(slider, normalized);
    output.textContent = output.value;
    renderScaleItem(
      slider === elements.feedSlider ? elements.feedScale : elements.articleScale,
      normalized,
    );
  }

  function resetForm(form) {
    form.reset();
    form.querySelectorAll(".calibration-radio").forEach((label) => {
      label.classList.remove("is-selected");
    });
    form
      .querySelectorAll(".calibration-evidence-factor[data-no-harm-dependent]")
      .forEach((fieldset) => {
        fieldset.disabled = false;
        delete fieldset.dataset.autoSelected;
      });
  }

  function selectedValue(form, name) {
    const checkedRadio = form.querySelector(
      `input[type="radio"][name="${name}"]:checked`,
    );

    if (checkedRadio) {
      return checkedRadio.value;
    }

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

  function requiresGuidedRerating(record) {
    const versions = [
      record?.feedRating?.assessment?.rubricVersion,
      record?.articleRating?.assessment?.rubricVersion,
    ].filter(Boolean);
    return versions.some((version) => version !== guidance.version);
  }

  function radioLabel(name, value, text, required = false) {
    const label = document.createElement("label");
    label.className = "calibration-radio";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = String(value);
    input.required = required;

    const marker = document.createElement("span");
    marker.className = "calibration-radio-marker";
    marker.setAttribute("aria-hidden", "true");
    marker.textContent = "X";

    label.append("[", marker, `] ${text}`);
    label.prepend(input);
    return label;
  }

  function renderEvidenceGroups(stage) {
    stage.evidenceGroups.replaceChildren();

    for (const factor of guidance.factors) {
      const fieldset = document.createElement("fieldset");
      fieldset.className = "calibration-field calibration-evidence-factor";
      fieldset.dataset.factorId = factor.id;
      if (NO_HARM_DEPENDENT_FACTORS.has(factor.id)) {
        fieldset.dataset.noHarmDependent = "true";
      }

      const legend = document.createElement("legend");
      legend.textContent = factor.label;
      fieldset.append(legend);

      factor.options.forEach((option, level) => {
        fieldset.append(
          radioLabel(
            `${stage.id}-factor-${factor.id}`,
            level,
            option,
            level === 0,
          ),
        );
      });
      stage.evidenceGroups.append(fieldset);
    }
  }

  function applyNoHarmShortcut(stage) {
    const harmLevel = selectedValue(
      stage.form,
      `${stage.id}-factor-harm`,
    );
    const noMaterialHarm = harmLevel === "0";

    stage.evidenceGroups
      .querySelectorAll(".calibration-evidence-factor[data-no-harm-dependent]")
      .forEach((fieldset) => {
        const radios = [...fieldset.querySelectorAll('input[type="radio"]')];

        if (noMaterialHarm) {
          radios.forEach((radio) => {
            radio.checked = radio.value === "0";
            radio.closest(".calibration-radio")?.classList.toggle(
              "is-selected",
              radio.checked,
            );
          });
          fieldset.dataset.autoSelected = "true";
          fieldset.disabled = true;
          return;
        }

        fieldset.disabled = false;
        if (fieldset.dataset.autoSelected === "true") {
          radios.forEach((radio) => {
            radio.checked = false;
            radio.closest(".calibration-radio")?.classList.remove("is-selected");
          });
          delete fieldset.dataset.autoSelected;
        }
      });
  }

  function selectedLevels(stage) {
    return Object.fromEntries(
      guidance.factors.map((factor) => [
        factor.id,
        selectedValue(stage.form, `${stage.id}-factor-${factor.id}`),
      ]),
    );
  }

  function selectedRadio(form, name, value) {
    const input = form.querySelector(
      `input[name="${name}"][value="${String(value)}"]`,
    );
    if (!input) return null;
    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input;
  }

  function updateRecommendation(stage, { initializeManual = false } = {}) {
    const recommendation = guidance.recommendation(
      selectedLevels(stage),
      doomIndex.severityScale,
    );
    stage.currentRecommendation = recommendation;
    const ratingChoices = stage.form.querySelectorAll(
      `input[name="${stage.ratingChoiceName}"]`,
    );

    if (!recommendation) {
      stage.recommendation.hidden = true;
      stage.manualRating.hidden = true;
      ratingChoices.forEach((input) => {
        input.disabled = true;
      });
      return;
    }

    ratingChoices.forEach((input) => {
      input.disabled = false;
    });
    stage.recommendation.hidden = false;
    stage.recommendationOutput.value = `${recommendation.band} ${recommendation.range.lower}–${recommendation.range.upper}`;
    stage.recommendationOutput.textContent =
      stage.recommendationOutput.value;
    stage.recommendationReasoning.textContent =
      severityBandForScore(recommendation.score)?.description || "";
    stage.recommendation
      .querySelectorAll("[data-rating-value]")
      .forEach((element) => {
        element.textContent = String(
          recommendation.range[element.dataset.ratingValue],
        );
      });

    const choice = selectedValue(stage.form, stage.ratingChoiceName);
    stage.manualRating.hidden = choice !== "manual";
    if (choice === "manual" && initializeManual) {
      setSlider(
        stage.slider,
        stage.output,
        stage.slider.min,
        false,
      );
      stage.validation.hidden = true;
    }
  }

  function generatedReasoning(recommendation, additionalContext) {
    const context = String(additionalContext || "").trim();
    const structuredReasoning = [
      recommendation.reasoning,
      ...recommendation.constraints,
    ].join(" ");
    return context
      ? `${structuredReasoning} Additional context: ${context}`
      : structuredReasoning;
  }

  function blindReviewExplanationReasons(
    stage,
    selection,
    selectedScore,
    recommendation,
  ) {
    if (!reviewMode) return [];

    const reasons = [];
    const recommendedBand = recommendation.effectiveBand || recommendation.band;
    const selectedBand = severityBandForScore(selectedScore)?.label || "UNCLASSIFIED";

    if (
      selection === "manual" &&
      (selectedScore < recommendation.range.lower ||
        selectedScore > recommendation.range.upper)
    ) {
      reasons.push("the exact score is outside the suggested range");
    }
    if (selection === "manual" && selectedBand !== recommendedBand) {
      reasons.push("the exact score changes the suggested severity band");
    }
    if (selectedScore >= 60) {
      reasons.push("the rating is Dire or Catastrophic");
    }
    if (stage.id === "article") {
      const article = articles[currentIndex];
      const feedScore = Number(state.ratings[storyKey(article)]?.feedRating?.score);
      if (Number.isFinite(feedScore) && Math.abs(selectedScore - feedScore) >= 15) {
        reasons.push("the full article changes the rating by at least 15 points");
      }
    }

    return [...new Set(reasons)];
  }

  function stageRating(stage) {
    const recommendation = stage.currentRecommendation;
    const selection = selectedValue(stage.form, stage.ratingChoiceName);

    if (!recommendation || !selection) return null;
    if (
      selection === "manual" &&
      stage.slider.dataset.interacted !== "true"
    ) {
      stage.validation.hidden = false;
      stage.slider.focus();
      return null;
    }

    const additionalContext = stage.form.elements.reasoning.value.trim();
    const selectedScore =
      selection === "manual"
        ? humanScore(stage.slider.value)
        : recommendation.range[selection];
    const explanationReasons = blindReviewExplanationReasons(
      stage,
      selection,
      selectedScore,
      recommendation,
    );
    const reasoningField = stage.form.elements.reasoning;

    if (explanationReasons.length && !additionalContext) {
      reasoningField.setCustomValidity(
        `Briefly explain why ${explanationReasons.join(" and ")}.`,
      );
      reasoningField.reportValidity();
      reasoningField.focus();
      return null;
    }
    reasoningField.setCustomValidity("");

    return {
      score: selectedScore,
      confidence: Number(
        selectedValue(stage.form, stage.confidenceName),
      ),
      reasoning: generatedReasoning(recommendation, additionalContext),
      assessment: {
        rubricVersion: recommendation.rubricVersion,
        factors: recommendation.selected,
        recommendation: {
          rawScore: recommendation.rawScore,
          score: recommendation.score,
          band: recommendation.band,
          requestedBand: recommendation.requestedBand,
          effectiveBand: recommendation.effectiveBand,
          supportIntensity: recommendation.supportIntensity,
          range: recommendation.range,
          direEligible: recommendation.direEligible,
          catastrophicEligible: recommendation.catastrophicEligible,
          constraints: recommendation.constraints,
        },
        selection,
        additionalContext,
        reviewFlags: explanationReasons,
      },
    };
  }

  function hydrateStage(stage, rating) {
    const assessment = rating?.assessment;

    if (
      assessment?.rubricVersion === guidance.version &&
      assessment?.factors
    ) {
      for (const factor of guidance.factors) {
        const selected = assessment.factors[factor.id];
        if (selected && Number.isInteger(Number(selected.level))) {
          selectedRadio(
            stage.form,
            `${stage.id}-factor-${factor.id}`,
            selected.level,
          );
        }
      }
      applyNoHarmShortcut(stage);
      updateRecommendation(stage);
      selectedRadio(
        stage.form,
        stage.ratingChoiceName,
        assessment.selection || "middle",
      );
      updateRecommendation(stage);
      if (assessment.selection === "manual") {
        setSlider(stage.slider, stage.output, rating.score, true);
      }
    }

    const confidence = stage.form.querySelector(
      `input[name="${stage.confidenceName}"][value="${rating?.confidence}"]`,
    );
    if (confidence) {
      confidence.checked = true;
      confidence.dispatchEvent(new Event("change", { bubbles: true }));
    }
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
        doomIndex.shadow?.version || article.doomIndexV124ShadowVersion || "1.2.4",
      ),
      formulaVersion: String(
        doomIndex.shadow?.formulaVersion ||
          article.doomIndexV124ShadowFormulaVersion ||
          "unknown",
      ),
      score: score(article.doomIndexV124Shadow),
    };
  }

  function severityBandForScore(value) {
    const scale = Array.isArray(doomIndex.severityScale)
      ? doomIndex.severityScale
      : [];
    const normalized = humanScore(value) ?? 0;

    return (
      scale.find(
        (band) =>
          normalized >= Number(band.minimum) &&
          normalized <= Number(band.maximum),
      ) || scale[0]
    );
  }

  function renderScaleItem(container, value) {
    const band = severityBandForScore(value);

    container.replaceChildren();
    if (!band) return;

    const item = document.createElement("div");
    item.className = "calibration-scale-item";

    const description = document.createElement("span");
    description.textContent = band.description || "";

    item.append(description);

    if (band.qualification) {
      const qualification = document.createElement("p");
      qualification.className = "calibration-scale-qualification";
      qualification.textContent = band.qualification;
      item.append(qualification);
    }
    container.append(item);
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

    const feedSummary = feedSummaryForCalibration(article);
    elements.summary.textContent = feedSummary;
    elements.summary.hidden = !feedSummary;
    elements.summaryNote.textContent = feedSummary
      ? ""
      : "No feed summary was supplied for this story. Rate this stage from the title only, or skip it.";
    elements.summaryNote.hidden = Boolean(feedSummary);

    elements.frame.src = article.url;
    elements.frame.title = `Article: ${article.title}`;
    elements.openStory.href = article.url;

    resetForm(elements.feedForm);
    resetForm(elements.articleForm);
    setSlider(elements.feedSlider, elements.feedOutput, 0, false);
    setSlider(elements.articleSlider, elements.articleOutput, 0, false);
    elements.feedValidation.hidden = true;
    elements.articleValidation.hidden = true;
    for (const stage of Object.values(stages)) {
      stage.currentRecommendation = null;
      updateRecommendation(stage);
    }
    elements.result.hidden = true;

    const record = currentRecord();
    const reratingRequired = requiresGuidedRerating(record);

    if (
      record?.status === "in-progress" &&
      record.feedRating &&
      !reratingRequired
    ) {
      showArticleStage(record);
      elements.status.textContent = "Feed rating saved locally. Complete the article-informed rating.";
    } else if (record?.status === "rated" && !reratingRequired) {
      showResult(record);
    } else {
      elements.feedStage.hidden = false;
      elements.articleStage.hidden = true;
      elements.status.textContent = reratingRequired
        ? "The guided questionnaire has changed. Complete this story again using version 1.1."
        : "";
    }

    updateProgress();
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function showArticleStage(record) {
    elements.feedStage.hidden = true;
    elements.articleStage.hidden = false;
    elements.result.hidden = true;
    elements.articleForm.elements["reasoning"].value = "";
    hydrateStage(stages.article, record.feedRating);
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

    if (reviewMode) {
      elements.comparison.append(
        comparisonItem("Feed review", humanScoreText(record.feedRating.score)),
        comparisonItem(
          "Article review",
          humanScoreText(record.articleRating.score),
        ),
        comparisonItem(
          "Article context adjustment",
          signedDifference(record.articleRating.score, record.feedRating.score, 0),
        ),
      );
      elements.status.textContent =
        "Blind review saved locally. Previous ratings and DREAD scores remain hidden.";
      updateProgress();
      return;
    }

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

      if (
        !record ||
        !["rated", "skipped"].includes(record.status) ||
        requiresGuidedRerating(record)
      ) {
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
    if (!elements.feedForm.reportValidity()) return;

    const humanRating = stageRating(stages.feed);
    if (!humanRating) return;

    const article = currentArticle();
    const key = storyKey(article);
    const now = new Date().toISOString();
    const feedSummary = feedSummaryForCalibration(article);

    state.ratings[key] = {
      status: "in-progress",
      article: articleIdentity(article),
      feedEvidence: {
        summary: feedSummary,
        summaryAvailable: Boolean(feedSummary),
      },
      scoringInput: modelScoringInput(article),
      feedRating: {
        ...humanRating,
        ratedAt: now,
      },
      ...(reviewMode
        ? {}
        : {
            models: {
              public: publicModel(article),
              shadow: shadowModel(article),
            },
          }),
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

    const humanRating = stageRating(stages.article);
    if (!humanRating) return;

    const article = currentArticle();
    const key = storyKey(article);
    const record = state.ratings[key];
    const now = new Date().toISOString();

    record.status = "rated";
    record.articleRating = {
      ...humanRating,
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

  function resetSkipForm() {
    elements.skipForm.reset();
    elements.skipForm
      .querySelectorAll('input[type="radio"]')
      .forEach((radio) => {
        radio.checked = false;
        radio
          .closest(".calibration-radio")
          ?.classList.remove("is-selected");
      });
  }

  function openSkipDialog() {
    resetSkipForm();
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
      scoringInput: existing?.scoringInput || modelScoringInput(article),
      skip: {
        reason: selectedValue(elements.skipForm, "skip-reason"),
        details: elements.skipForm.elements["skip-details"].value.trim(),
        skippedAt: now,
      },
      ...(reviewMode
        ? {}
        : {
            models: existing?.models || {
              public: publicModel(article),
              shadow: shadowModel(article),
            },
          }),
      startedAt: existing?.startedAt || now,
      completedAt: now,
      updatedAt: now,
    };

    saveState();
    elements.skipDialog.close();
    advanceStory();
  }

  function exportRatings() {
    const currentArticles = new Map(
      articles.map((article) => [storyKey(article), article]),
    );
    const records = Object.entries(state.ratings).map(([key, record]) => {
      const article = currentArticles.get(key);
      const capturedInput = article ? modelScoringInput(article) : null;
      const existingInputIsExact =
        record.scoringInput?.provenance === "production";

      return capturedInput && !existingInputIsExact
        ? { ...record, scoringInput: capturedInput }
        : record;
    });
    const sharedPayload = {
      schemaVersion: state.schemaVersion,
      exportedAt: new Date().toISOString(),
      calibrationMethod: {
        firstJudgment: "title-and-feed-summary",
        secondJudgment: "full-article-confirmation-or-revision",
        humanRatingMethod: guidance.version,
        structuredFactors: guidance.factors.map((factor) => factor.id),
        modelScoresHiddenUntil: "both-human-judgments-complete",
      },
      severityScale: doomIndex.severityScale || [],
      totals: {
        availableStories: articles.length,
        rated: records.filter((record) => record.status === "rated").length,
        skipped: records.filter((record) => record.status === "skipped").length,
        inProgress: records.filter((record) => record.status === "in-progress").length,
      },
      records,
    };
    const payload = reviewMode
      ? {
          ...sharedPayload,
          exportType: "blind-calibration-review",
          reviewQueue: {
            version: reviewQueue.queueVersion || null,
            fingerprint: reviewQueue.queueFingerprint || null,
            sourceBenchmarkVersion: reviewQueue.sourceBenchmarkVersion || null,
            sourceBenchmarkAsOf: reviewQueue.sourceBenchmarkAsOf || null,
            totalRecords: Number(reviewQueue.totals?.records || articles.length),
            eligibleBenchmarkIds: reviewQueue.records.map((record) =>
              String(record.benchmarkId),
            ),
          },
          blindness: {
            previousHumanRatingsHidden: true,
            questionnaireRecommendationsFromPreviousPassHidden: true,
            modelScoresHidden: true,
            queueOrder: "deterministically-shuffled",
          },
        }
      : {
          ...sharedPayload,
          modelConfiguration: {
            public: {
              name: String(doomIndex.modelName || "DREAD").toUpperCase(),
              version: doomIndex.version || null,
              formulaVersion: doomIndex.formulaVersion || null,
            },
            shadow: doomIndex.shadow || null,
          },
        };

    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = reviewMode
      ? `dread-blind-review-${date}.json`
      : `dread-human-calibration-${date}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    elements.status.textContent = reviewMode
      ? "Blind review ratings exported."
      : "Calibration ratings exported.";
  }

  function updateSlider(event) {
    const slider = event.currentTarget;
    const stage = slider === elements.feedSlider ? stages.feed : stages.article;
    slider.dataset.interacted = "true";
    stage.output.value = sliderOutputText(slider, slider.value);
    stage.output.textContent = stage.output.value;
    renderScaleItem(stage.scale, slider.value);
    stage.validation.hidden = true;
  }

  function updateGuidedForm(event, stage) {
    updateRadioStyle(event);
    const input = event.target.closest('input[type="radio"]');
    if (!input) return;

    if (input.name === `${stage.id}-factor-harm`) {
      applyNoHarmShortcut(stage);
    }

    const choseManual =
      input.name === stage.ratingChoiceName &&
      input.checked &&
      input.value === "manual";
    if (
      input.name.startsWith(`${stage.id}-factor-`) ||
      input.name === stage.ratingChoiceName
    ) {
      updateRecommendation(stage, { initializeManual: choseManual });
    }
  }

  elements.feedSlider.addEventListener("input", updateSlider);
  elements.feedSlider.addEventListener("change", updateSlider);
  elements.articleSlider.addEventListener("input", updateSlider);
  elements.articleSlider.addEventListener("change", updateSlider);
  elements.feedForm.addEventListener("change", (event) => {
    updateGuidedForm(event, stages.feed);
  });
  elements.articleForm.addEventListener("change", (event) => {
    updateGuidedForm(event, stages.article);
  });
  [elements.feedForm, elements.articleForm].forEach((form) => {
    form.elements.reasoning.addEventListener("input", (event) => {
      event.currentTarget.setCustomValidity("");
    });
  });
  elements.skipForm.addEventListener("change", updateRadioStyle);
  elements.feedForm.addEventListener("submit", handleFeedSubmit);
  elements.articleForm.addEventListener("submit", handleArticleSubmit);
  elements.nextButton.addEventListener("click", advanceStory);
  elements.exportButton.addEventListener("click", exportRatings);
  elements.skipForm.addEventListener("submit", handleSkipSubmit);
  elements.cancelSkip.addEventListener("click", () => elements.skipDialog.close());
  elements.skipDialog.addEventListener("close", resetSkipForm);
  document.querySelectorAll("[data-skip-story]").forEach((button) => {
    button.addEventListener("click", openSkipDialog);
  });

  renderEvidenceGroups(stages.feed);
  renderEvidenceGroups(stages.article);
  if (reviewMode) {
    document.title = "DREAD BLIND CALIBRATION REVIEW";
    const logo = document.querySelector(".calibration-logo");
    if (logo) logo.textContent = "Daily Doomsayer / Blind Review";
    const guardrail = document.createElement("p");
    guardrail.className = "calibration-note calibration-review-instruction";
    guardrail.textContent =
      "Rate only the event described by this headline—not background incidents, hypothetical outcomes, or the problem a protective measure addresses.";
    elements.title.closest(".calibration-story-context")?.prepend(guardrail);
  }
  renderScaleItem(stages.feed.scale, stages.feed.slider.value);
  renderScaleItem(stages.article.scale, stages.article.slider.value);
  renderStory();
})();
