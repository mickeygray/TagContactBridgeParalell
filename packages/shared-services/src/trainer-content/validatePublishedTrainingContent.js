"use strict";

const {
  CONTENT_STATUSES,
  RULE_AUTHORITY_TYPES,
  DETERMINISTIC_AUTHORITY_TYPES,
  COURSE_ITEM_TYPES,
  SCENARIO_NODE_TYPES,
  OVERLAY_SCOPE_KEYS,
  DIRECTIONS,
} = require("./publishedTrainingContentContracts");

const { validateTargetedTalkBlueprint } = require("./validateTargetedTalkBlueprint");

class PublishedTrainingContentValidationError extends Error {
  constructor(issues) {
    super(`Published Trainer content is invalid (${issues.length} issue${issues.length === 1 ? "" : "s"})`);
    this.name = "PublishedTrainingContentValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function collectPublishedTrainingContentIssues(content, options = {}) {
  const issues = [];
  const seenIds = new Map();
  const allowTestContent = options.allowTestContent === true;
  const root = isObject(content) ? content : {};
  const rootIsTestOnly = root.testOnly === true;

  const addIssue = (code, path, message) => {
    issues.push(Object.freeze({ code, path, message }));
  };

  const requireIdentity = (entity, entityPath, kind) => {
    if (!isObject(entity)) {
      addIssue("entity.invalid", entityPath, `${kind} must be an object`);
      return null;
    }
    const id = hasText(entity.id) ? entity.id.trim() : null;
    if (!id) {
      addIssue("id.missing", `${entityPath}.id`, `${kind} must have a non-empty id`);
    } else if (seenIds.has(id)) {
      addIssue(
        "id.duplicate",
        `${entityPath}.id`,
        `${kind} id "${id}" duplicates ${seenIds.get(id)}`,
      );
    } else {
      seenIds.set(id, entityPath);
    }
    if (!hasText(entity.version)) {
      addIssue("version.missing", `${entityPath}.version`, `${kind} "${id || entityPath}" must have a version`);
    }
    return id;
  };

  const validateStatus = (entity, entityPath, kind) => {
    if (!CONTENT_STATUSES.includes(entity.status)) {
      addIssue(
        "status.invalid",
        `${entityPath}.status`,
        `${kind} status must be one of ${CONTENT_STATUSES.join(", ")}`,
      );
    }
  };

  if (!isObject(content)) {
    addIssue("content.invalid", "content", "Published Trainer content must be an object");
    return issues;
  }

  requireIdentity(root, "content", "content bundle");
  validateStatus(root, "content", "content bundle");
  if (rootIsTestOnly && !allowTestContent) {
    addIssue(
      "test-content.disabled",
      "content.testOnly",
      "Test-only Trainer content requires allowTestContent: true",
    );
  }

  const ruleRegistry = isObject(root.ruleRegistry) ? root.ruleRegistry : {};
  requireIdentity(ruleRegistry, "content.ruleRegistry", "rule registry");
  validateStatus(ruleRegistry, "content.ruleRegistry", "rule registry");
  const rules = list(ruleRegistry.rules);
  if (!Array.isArray(ruleRegistry.rules)) {
    addIssue("rules.invalid", "content.ruleRegistry.rules", "Rule registry rules must be an array");
  }

  const rulesById = new Map();
  rules.forEach((rule, index) => {
    const rulePath = `content.ruleRegistry.rules[${index}]`;
    const ruleId = requireIdentity(rule, rulePath, "rule");
    if (!isObject(rule)) return;
    validateStatus(rule, rulePath, "rule");
    if (ruleId && !rulesById.has(ruleId)) rulesById.set(ruleId, rule);

    const authority = rule.authority;
    if (!isObject(authority)) {
      addIssue("authority.missing", `${rulePath}.authority`, `Rule "${ruleId || rulePath}" must declare authority`);
      return;
    }
    if (!RULE_AUTHORITY_TYPES.includes(authority.type)) {
      addIssue(
        "authority.type.invalid",
        `${rulePath}.authority.type`,
        `Rule authority must be one of ${RULE_AUTHORITY_TYPES.join(", ")}`,
      );
    }
    if (authority.type === "test-fixture" && !(rootIsTestOnly && allowTestContent)) {
      addIssue(
        "authority.test-only",
        `${rulePath}.authority.type`,
        "test-fixture authority is valid only for an explicitly enabled test-only bundle",
      );
    }
    if (!Array.isArray(authority.citations) || authority.citations.length === 0) {
      addIssue(
        "authority.citations.missing",
        `${rulePath}.authority.citations`,
        `Rule "${ruleId || rulePath}" must have at least one citation`,
      );
    } else {
      authority.citations.forEach((citation, citationIndex) => {
        if (!hasText(citation)) {
          addIssue(
            "authority.citation.invalid",
            `${rulePath}.authority.citations[${citationIndex}]`,
            "Citations must be non-empty strings",
          );
        }
      });
    }
  });

  const courseManifest = isObject(root.courseManifest) ? root.courseManifest : {};
  requireIdentity(courseManifest, "content.courseManifest", "course manifest");
  validateStatus(courseManifest, "content.courseManifest", "course manifest");
  const items = list(courseManifest.items);
  if (!Array.isArray(courseManifest.items)) {
    addIssue("items.invalid", "content.courseManifest.items", "Course items must be an array");
  }

  const itemsById = new Map();
  items.forEach((item, index) => {
    const itemPath = `content.courseManifest.items[${index}]`;
    const itemId = requireIdentity(item, itemPath, "course item");
    if (!isObject(item)) return;
    validateStatus(item, itemPath, "course item");
    if (itemId && !itemsById.has(itemId)) itemsById.set(itemId, item);
    if (!COURSE_ITEM_TYPES.includes(item.type)) {
      addIssue(
        "item.type.invalid",
        `${itemPath}.type`,
        `Course item type must be one of ${COURSE_ITEM_TYPES.join(", ")}`,
      );
    }
  });

  const assertRuleRefs = (ruleIds, refsPath, context) => {
    if (!Array.isArray(ruleIds)) {
      addIssue("reference.rules.invalid", refsPath, `${context} ruleIds must be an array`);
      return [];
    }
    const unique = new Set();
    ruleIds.forEach((ruleId, index) => {
      if (!hasText(ruleId)) {
        addIssue("reference.rule.invalid", `${refsPath}[${index}]`, `${context} rule reference must be a non-empty string`);
      } else if (unique.has(ruleId)) {
        addIssue("reference.rule.duplicate", `${refsPath}[${index}]`, `${context} repeats rule "${ruleId}"`);
      } else {
        unique.add(ruleId);
        if (!rulesById.has(ruleId)) {
          addIssue("reference.rule.missing", `${refsPath}[${index}]`, `${context} references unknown rule "${ruleId}"`);
        }
      }
    });
    return [...unique];
  };

  const validateDeterministicGate = (gate, gatePath, context) => {
    if (!isObject(gate) || gate.required !== true || gate.deterministic !== true) return;
    const requiredRuleIds = assertRuleRefs(gate.ruleIds, `${gatePath}.ruleIds`, `${context} deterministic gate`);
    if (requiredRuleIds.length === 0) {
      addIssue(
        "deterministic.rules.missing",
        `${gatePath}.ruleIds`,
        `${context} required deterministic gate must reference at least one rule`,
      );
    }
    requiredRuleIds.forEach((ruleId) => {
      const rule = rulesById.get(ruleId);
      if (!rule) return;
      if (rule.status !== "published") {
        addIssue(
          "deterministic.rule.unpublished",
          `${gatePath}.ruleIds`,
          `${context} cannot require ${rule.status || "unversioned"} rule "${ruleId}"`,
        );
      }
      const authorityType = rule.authority?.type;
      const syntheticAllowed = authorityType === "test-fixture" && rootIsTestOnly && allowTestContent;
      if (!DETERMINISTIC_AUTHORITY_TYPES.includes(authorityType) && !syntheticAllowed) {
        addIssue(
          "deterministic.authority.invalid",
          `${gatePath}.ruleIds`,
          `${context} cannot deterministically require rule "${ruleId}" from ${authorityType || "missing"} authority`,
        );
      }
    });
  };

  const validateChoiceAssessment = (item, itemPath, context) => {
    const presentation = isObject(item?.presentation)
      ? item.presentation
      : null;
    const hasChoices =
      presentation && Object.hasOwn(presentation, "choices");
    const requiresAssessment = ["quiz", "say-it"].includes(item?.type);
    if (!requiresAssessment && !hasChoices) return;

    const assessment = item?.assessment;
    if (!isObject(assessment)) {
      addIssue(
        "assessment.missing",
        `${itemPath}.assessment`,
        `${context} must declare a server-owned assessment`,
      );
      return;
    }
    if (!hasText(assessment.version)) {
      addIssue(
        "assessment.version.missing",
        `${itemPath}.assessment.version`,
        `${context} assessment must have a version`,
      );
    }
    if (!hasText(assessment.canonicalAnswer)) {
      addIssue(
        "assessment.canonical.missing",
        `${itemPath}.assessment.canonicalAnswer`,
        `${context} assessment must have a canonical answer`,
      );
    }
    if (
      Object.hasOwn(assessment, "acceptedAnswers") &&
      !Array.isArray(assessment.acceptedAnswers)
    ) {
      addIssue(
        "assessment.accepted.invalid",
        `${itemPath}.assessment.acceptedAnswers`,
        `${context} accepted answers must be an array`,
      );
    }

    const normalizeAssessmentValue = hasChoices
      ? (value) => value.trim()
      : (value) => value.trim().replace(/\s+/g, " ").toLowerCase();
    const canonical = hasText(assessment.canonicalAnswer)
      ? normalizeAssessmentValue(assessment.canonicalAnswer)
      : null;
    const acceptedValues = new Set();
    if (Array.isArray(assessment.acceptedAnswers)) {
      assessment.acceptedAnswers.forEach((acceptedAnswer, answerIndex) => {
        const answerPath =
          `${itemPath}.assessment.acceptedAnswers[${answerIndex}]`;
        if (!hasText(acceptedAnswer)) {
          addIssue(
            "assessment.accepted.value.invalid",
            answerPath,
            `${context} accepted answers must be non-empty strings`,
          );
          return;
        }
        const normalized = normalizeAssessmentValue(acceptedAnswer);
        if (normalized === canonical || acceptedValues.has(normalized)) {
          addIssue(
            "assessment.accepted.value.duplicate",
            answerPath,
            `${context} repeats an accepted answer`,
          );
        } else {
          acceptedValues.add(normalized);
        }
      });
    }

    if (!hasChoices) return;
    const choices = presentation.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      addIssue(
        "assessment.choices.invalid",
        `${itemPath}.presentation.choices`,
        `${context} choices must be a non-empty array`,
      );
      return;
    }
    const choiceIds = new Set();
    choices.forEach((choice, choiceIndex) => {
      const choicePath = `${itemPath}.presentation.choices[${choiceIndex}]`;
      if (!isObject(choice) || !hasText(choice.choiceId)) {
        addIssue(
          "assessment.choice.id.invalid",
          `${choicePath}.choiceId`,
          `${context} choice IDs must be non-empty strings`,
        );
      } else {
        const choiceId = choice.choiceId.trim();
        if (choiceIds.has(choiceId)) {
          addIssue(
            "assessment.choice.id.duplicate",
            `${choicePath}.choiceId`,
            `${context} repeats choice ID "${choiceId}"`,
          );
        } else {
          choiceIds.add(choiceId);
        }
      }
      if (!isObject(choice) || !hasText(choice.label)) {
        addIssue(
          "assessment.choice.label.invalid",
          `${choicePath}.label`,
          `${context} choice labels must be non-empty strings`,
        );
      }
    });
    if (canonical && !choiceIds.has(canonical)) {
      addIssue(
        "assessment.canonical.choice-missing",
        `${itemPath}.assessment.canonicalAnswer`,
        `${context} canonical answer must reference a presented choice ID`,
      );
    }
    if (Array.isArray(assessment.acceptedAnswers)) {
      assessment.acceptedAnswers.forEach((acceptedAnswer, answerIndex) => {
        if (!hasText(acceptedAnswer)) return;
        const acceptedId = acceptedAnswer.trim();
        if (!choiceIds.has(acceptedId)) {
          addIssue(
            "assessment.accepted.choice-missing",
            `${itemPath}.assessment.acceptedAnswers[${answerIndex}]`,
            `${context} accepted answers must reference presented choice IDs`,
          );
        }
      });
    }
  };
  items.forEach((item, index) => {
    if (!isObject(item)) return;
    const itemPath = `content.courseManifest.items[${index}]`;
    assertRuleRefs(item.ruleIds, `${itemPath}.ruleIds`, `Course item "${item.id || itemPath}"`);
    const prerequisites = list(item.prerequisiteItemIds);
    if (!Array.isArray(item.prerequisiteItemIds)) {
      addIssue(
        "prerequisites.invalid",
        `${itemPath}.prerequisiteItemIds`,
        `Course item "${item.id || itemPath}" prerequisiteItemIds must be an array`,
      );
    }
    const seenPrerequisites = new Set();
    prerequisites.forEach((prerequisiteId, prerequisiteIndex) => {
      const refPath = `${itemPath}.prerequisiteItemIds[${prerequisiteIndex}]`;
      if (!hasText(prerequisiteId)) {
        addIssue("reference.prerequisite.invalid", refPath, "Prerequisite reference must be a non-empty string");
      } else if (seenPrerequisites.has(prerequisiteId)) {
        addIssue("reference.prerequisite.duplicate", refPath, `Prerequisite "${prerequisiteId}" is repeated`);
      } else {
        seenPrerequisites.add(prerequisiteId);
        if (!itemsById.has(prerequisiteId)) {
          addIssue("reference.prerequisite.missing", refPath, `Unknown prerequisite item "${prerequisiteId}"`);
        }
        if (prerequisiteId === item.id) {
          addIssue("prerequisite.self", refPath, `Course item "${item.id}" cannot require itself`);
        }
      }
    });
    validateDeterministicGate(item.grading, `${itemPath}.grading`, `Course item "${item.id || itemPath}"`);
    validateChoiceAssessment(item, itemPath, `Course item "${item.id || itemPath}"`);
  });

  const visitState = new Map();
  const visitItem = (itemId, ancestry) => {
    const state = visitState.get(itemId);
    if (state === "done") return;
    if (state === "visiting") {
      const start = ancestry.indexOf(itemId);
      const cycle = [...ancestry.slice(start), itemId];
      addIssue(
        "prerequisite.cycle",
        "content.courseManifest.items",
        `Course prerequisite cycle: ${cycle.join(" -> ")}`,
      );
      return;
    }
    visitState.set(itemId, "visiting");
    const item = itemsById.get(itemId);
    list(item?.prerequisiteItemIds)
      .filter((prerequisiteId) => itemsById.has(prerequisiteId))
      .forEach((prerequisiteId) => visitItem(prerequisiteId, [...ancestry, itemId]));
    visitState.set(itemId, "done");
  };
  [...itemsById.keys()].forEach((itemId) => visitItem(itemId, []));

  const overlays = list(courseManifest.overlays);
  if (!Array.isArray(courseManifest.overlays)) {
    addIssue("overlays.invalid", "content.courseManifest.overlays", "Course overlays must be an array");
  }
  overlays.forEach((overlay, index) => {
    const overlayPath = `content.courseManifest.overlays[${index}]`;
    requireIdentity(overlay, overlayPath, "course overlay");
    if (!isObject(overlay)) return;
    validateStatus(overlay, overlayPath, "course overlay");
    const scope = overlay.scope;
    if (!isObject(scope)) {
      addIssue("overlay.scope.missing", `${overlayPath}.scope`, "Overlay must declare a scope");
    } else {
      const keys = Object.keys(scope);
      if (keys.length === 0) {
        addIssue("overlay.scope.empty", `${overlayPath}.scope`, "Overlay scope cannot be empty");
      }
      keys.forEach((key) => {
        if (!OVERLAY_SCOPE_KEYS.includes(key)) {
          addIssue("overlay.scope.key.invalid", `${overlayPath}.scope.${key}`, `Unsupported overlay scope key "${key}"`);
        }
      });
      if (Object.hasOwn(scope, "company") && !hasText(scope.company)) {
        addIssue("overlay.scope.company.invalid", `${overlayPath}.scope.company`, "Overlay company must be a non-empty string");
      }
      if (Object.hasOwn(scope, "direction") && !DIRECTIONS.includes(scope.direction)) {
        addIssue(
          "overlay.scope.direction.invalid",
          `${overlayPath}.scope.direction`,
          `Overlay direction must be one of ${DIRECTIONS.join(", ")}`,
        );
      }
    }
    if (!Array.isArray(overlay.itemOverrides) || overlay.itemOverrides.length === 0) {
      addIssue("overlay.overrides.missing", `${overlayPath}.itemOverrides`, "Overlay must contain at least one item override");
      return;
    }
    overlay.itemOverrides.forEach((override, overrideIndex) => {
      const overridePath = `${overlayPath}.itemOverrides[${overrideIndex}]`;
      if (!isObject(override) || !hasText(override.itemId)) {
        addIssue("overlay.item.invalid", `${overridePath}.itemId`, "Overlay item override must reference an item");
        return;
      }
      if (!itemsById.has(override.itemId)) {
        addIssue("overlay.item.missing", `${overridePath}.itemId`, `Overlay references unknown item "${override.itemId}"`);
      }
      if (Object.hasOwn(override, "ruleIds")) {
        assertRuleRefs(override.ruleIds, `${overridePath}.ruleIds`, `Overlay item "${override.itemId}"`);
      }
      const sourceItem = itemsById.get(override.itemId);
      if (sourceItem) {
        validateChoiceAssessment(
          { ...sourceItem, ...override, id: sourceItem.id },
          overridePath,
          `Overlay item "${override.itemId}"`,
        );
      }
    });
  });

  const scenarioBlueprints = list(root.scenarioBlueprints);
  if (!Array.isArray(root.scenarioBlueprints)) {
    addIssue("scenarios.invalid", "content.scenarioBlueprints", "Scenario blueprints must be an array");
  }
  scenarioBlueprints.forEach((scenario, scenarioIndex) => {
    const scenarioPath = `content.scenarioBlueprints[${scenarioIndex}]`;
    requireIdentity(scenario, scenarioPath, "scenario blueprint");
    if (!isObject(scenario)) return;
    validateStatus(scenario, scenarioPath, "scenario blueprint");
    assertRuleRefs(scenario.ruleIds, `${scenarioPath}.ruleIds`, `Scenario "${scenario.id || scenarioPath}"`);

    const nodes = list(scenario.nodes);
    const edges = list(scenario.edges);
    if (!Array.isArray(scenario.nodes) || nodes.length === 0) {
      addIssue("scenario.nodes.missing", `${scenarioPath}.nodes`, "Scenario must contain at least one node");
    }
    if (!Array.isArray(scenario.edges)) {
      addIssue("scenario.edges.invalid", `${scenarioPath}.edges`, "Scenario edges must be an array");
    }

    const nodeIds = new Set();
    const terminalNodeIds = new Set();
    nodes.forEach((node, nodeIndex) => {
      const nodePath = `${scenarioPath}.nodes[${nodeIndex}]`;
      const nodeId = requireIdentity(node, nodePath, "scenario node");
      if (!isObject(node)) return;
      if (nodeId) nodeIds.add(nodeId);
      if (!SCENARIO_NODE_TYPES.includes(node.type)) {
        addIssue(
          "scenario.node.type.invalid",
          `${nodePath}.type`,
          `Scenario node type must be one of ${SCENARIO_NODE_TYPES.join(", ")}`,
        );
      }
      if (node.type === "terminal") terminalNodeIds.add(nodeId);
      assertRuleRefs(node.ruleIds, `${nodePath}.ruleIds`, `Scenario node "${nodeId || nodePath}"`);
      validateDeterministicGate(node.gate, `${nodePath}.gate`, `Scenario node "${nodeId || nodePath}"`);
    });

    if (!hasText(scenario.startNodeId) || !nodeIds.has(scenario.startNodeId)) {
      addIssue("scenario.start.missing", `${scenarioPath}.startNodeId`, "Scenario startNodeId must reference a scenario node");
    }
    if (terminalNodeIds.size === 0) {
      addIssue("scenario.terminal.missing", `${scenarioPath}.nodes`, "Scenario must contain at least one terminal node");
    }

    const outgoing = new Map();
    edges.forEach((edge, edgeIndex) => {
      const edgePath = `${scenarioPath}.edges[${edgeIndex}]`;
      requireIdentity(edge, edgePath, "scenario edge");
      if (!isObject(edge)) return;
      if (!hasText(edge.from) || !nodeIds.has(edge.from)) {
        addIssue("scenario.edge.from.invalid", `${edgePath}.from`, `Scenario edge must reference an existing from node`);
      }
      if (!hasText(edge.to) || !nodeIds.has(edge.to)) {
        addIssue("scenario.edge.to.invalid", `${edgePath}.to`, `Scenario edge must reference an existing to node`);
      }
      if (scenario.experienceMode !== "gauntlet" && !hasText(edge.when)) {
        addIssue("scenario.edge.when.missing", `${edgePath}.when`, "Scenario edge must declare a transition condition");
      }
      if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) {
        const targets = outgoing.get(edge.from) || [];
        targets.push(edge.to);
        outgoing.set(edge.from, targets);
      }
    });

    nodes.forEach((node, nodeIndex) => {
      if (node?.type !== "terminal" && nodeIds.has(node?.id) && !outgoing.has(node.id)) {
        addIssue(
          "scenario.node.dead-end",
          `${scenarioPath}.nodes[${nodeIndex}]`,
          `Non-terminal scenario node "${node.id}" must have an outgoing edge`,
        );
      }
    });

    validateTargetedTalkBlueprint({
      scenario,
      scenarioPath,
      nodes,
      edges,
      nodeIds,
      terminalNodeIds,
      outgoing,
      rootIsTestOnly,
      allowTestContent,
      addIssue,
      hasText,
      isObject,
      list,
      requireIdentity,
      assertRuleRefs,
      rulesById,
    });

    if (nodeIds.has(scenario.startNodeId)) {
      const reachable = new Set();
      const stack = [scenario.startNodeId];
      while (stack.length > 0) {
        const nodeId = stack.pop();
        if (reachable.has(nodeId)) continue;
        reachable.add(nodeId);
        list(outgoing.get(nodeId)).forEach((targetId) => stack.push(targetId));
      }
      nodes.forEach((node, nodeIndex) => {
        if (nodeIds.has(node?.id) && !reachable.has(node.id)) {
          addIssue(
            "scenario.node.unreachable",
            `${scenarioPath}.nodes[${nodeIndex}]`,
            `Scenario node "${node.id}" is unreachable from startNodeId`,
          );
        }
      });
      if (![...terminalNodeIds].some((nodeId) => reachable.has(nodeId))) {
        addIssue(
          "scenario.terminal.unreachable",
          `${scenarioPath}.nodes`,
          "Scenario has no terminal node reachable from startNodeId",
        );
      }
    }
  });

  if (root.scriptBeatCoverage != null) {
    const coverage = root.scriptBeatCoverage;
    if (!isObject(coverage)) {
      addIssue("coverage.invalid", "content.scriptBeatCoverage", "Script-beat coverage must be an object");
    } else {
      const expectedBeatIds = list(coverage.expectedBeatIds);
      const bundles = list(coverage.bundles);
      if (!Array.isArray(coverage.expectedBeatIds) || expectedBeatIds.length === 0) {
        addIssue("coverage.beats.missing", "content.scriptBeatCoverage.expectedBeatIds", "Coverage must declare expected beat IDs");
      }
      if (!Array.isArray(coverage.bundles) || bundles.length === 0) {
        addIssue("coverage.bundles.missing", "content.scriptBeatCoverage.bundles", "Coverage must declare bundle mappings");
      }
      if (
        coverage.expectedBeatCount != null
        && (!Number.isInteger(coverage.expectedBeatCount) || coverage.expectedBeatCount < 1)
      ) {
        addIssue("coverage.beat-count.invalid", "content.scriptBeatCoverage.expectedBeatCount", "Expected beat count must be a positive integer");
      } else if (
        Number.isInteger(coverage.expectedBeatCount)
        && coverage.expectedBeatCount !== expectedBeatIds.length
      ) {
        addIssue(
          "coverage.beat-count.mismatch",
          "content.scriptBeatCoverage.expectedBeatIds",
          `Declared ${coverage.expectedBeatCount} beats but found ${expectedBeatIds.length}`,
        );
      }
      if (
        coverage.expectedBundleCount != null
        && (!Number.isInteger(coverage.expectedBundleCount) || coverage.expectedBundleCount < 1)
      ) {
        addIssue("coverage.bundle-count.invalid", "content.scriptBeatCoverage.expectedBundleCount", "Expected bundle count must be a positive integer");
      } else if (
        Number.isInteger(coverage.expectedBundleCount)
        && coverage.expectedBundleCount !== bundles.length
      ) {
        addIssue(
          "coverage.bundle-count.mismatch",
          "content.scriptBeatCoverage.bundles",
          `Declared ${coverage.expectedBundleCount} bundles but found ${bundles.length}`,
        );
      }

      const expected = new Set();
      expectedBeatIds.forEach((beatId, beatIndex) => {
        if (!hasText(beatId)) {
          addIssue("coverage.beat.invalid", `content.scriptBeatCoverage.expectedBeatIds[${beatIndex}]`, "Beat IDs must be non-empty strings");
        } else if (expected.has(beatId)) {
          addIssue("coverage.beat.duplicate", `content.scriptBeatCoverage.expectedBeatIds[${beatIndex}]`, `Expected beat "${beatId}" is duplicated`);
        } else {
          expected.add(beatId);
        }
      });

      const observedCounts = new Map();
      bundles.forEach((bundle, bundleIndex) => {
        const bundlePath = `content.scriptBeatCoverage.bundles[${bundleIndex}]`;
        requireIdentity(bundle, bundlePath, "script-beat bundle");
        if (!isObject(bundle)) return;
        if (!Array.isArray(bundle.beatIds) || bundle.beatIds.length === 0) {
          addIssue("coverage.bundle.empty", `${bundlePath}.beatIds`, "Coverage bundle must contain at least one beat");
          return;
        }
        const local = new Set();
        bundle.beatIds.forEach((beatId, beatIndex) => {
          const beatPath = `${bundlePath}.beatIds[${beatIndex}]`;
          if (!hasText(beatId)) {
            addIssue("coverage.bundle.beat.invalid", beatPath, "Coverage beat reference must be a non-empty string");
          } else if (local.has(beatId)) {
            addIssue("coverage.bundle.beat.duplicate", beatPath, `Bundle repeats beat "${beatId}"`);
          } else {
            local.add(beatId);
            if (!expected.has(beatId)) {
              addIssue("coverage.bundle.beat.unknown", beatPath, `Bundle references undeclared beat "${beatId}"`);
            }
            observedCounts.set(beatId, (observedCounts.get(beatId) || 0) + 1);
          }
        });
      });

      expected.forEach((beatId) => {
        const count = observedCounts.get(beatId) || 0;
        if (count === 0) {
          addIssue("coverage.beat.uncovered", "content.scriptBeatCoverage.bundles", `Expected beat "${beatId}" is uncovered`);
        } else if (count > 1) {
          addIssue(
            "coverage.beat.multiple",
            "content.scriptBeatCoverage.bundles",
            `Expected beat "${beatId}" is covered ${count} times`,
          );
        }
      });
    }
  }

  return issues;
}

function validatePublishedTrainingContent(content, options = {}) {
  const issues = collectPublishedTrainingContentIssues(content, options);
  if (issues.length > 0) {
    throw new PublishedTrainingContentValidationError(issues);
  }
  return true;
}

module.exports = {
  PublishedTrainingContentValidationError,
  collectPublishedTrainingContentIssues,
  validatePublishedTrainingContent,
};
