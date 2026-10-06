import type { Static } from "@sinclair/typebox"

import {
  ActorRefSchema,
  AndroidCheckpointSpecSchema,
  AndroidResolvedScenarioPlanSchema,
  AndroidRuntimeLocatorSchema,
  AndroidScenarioAuthoringSchema,
  AndroidScenarioStepSchema,
  AppRuntimeLocatorSchema,
  ArtifactRefSchema,
  AssertionResultSchema,
  AssertionSpecSchema,
  BuildIdentitySchema,
  DeploymentIdentitySchema,
  ExecutionTargetSchema,
  DeploymentVerificationSchema,
  CaptureBundleSchema,
  CaptureBundleSpecSchema,
  CaptureCapabilitySchema,
  CapturedCheckpointSchema,
  CheckpointSpecSchema,
  ComputedStyleEvidenceSchema,
  ConsoleEvidencePayloadSchema,
  ContractEnvelopeSchema,
  ContractMetadataSchema,
  AbstractPropertySchema,
  ContractVersionSchema,
  CoverageCountsSchema,
  CoverageReportSchema,
  DesignCapabilitySchema,
  DesignContractSchema,
  DesignContractSpecSchema,
  DesignRangeSchema,
  DesignScaleSchema,
  DesignTokenSetSchema,
  DesignUnitSchema,
  DesignValueSetSchema,
  DeterminismSchema,
  DigestSchema,
  DimensionScoreSchema,
  DomEvidencePayloadSchema,
  ElementBindingSchema,
  EvaluationPlanSchema,
  EvaluationPolicySchema,
  EvaluationPolicySpecSchema,
  EvaluationReportSchema,
  EvaluationReportSpecSchema,
  EvidencePayloadSchema,
  EvidenceRecordSchema,
  ExecutionEnvironmentSchema,
  ExecutionErrorSchema,
  FindingDimensionSchema,
  FindingSchema,
  FixtureRefSchema,
  FixtureSourceSchema,
  GateExpressionSchema,
  GateResultSchema,
  GeometryConstraintSchema,
  GeometryEvaluatorConfigSchema,
  IosCheckpointSpecSchema,
  IosResolvedScenarioPlanSchema,
  IosRuntimeLocatorSchema,
  IosScenarioAuthoringSchema,
  IosScenarioStepSchema,
  LayoutEvidencePayloadSchema,
  MatrixMapSchema,
  MatrixValueSchema,
  MetricValueSchema,
  MockServerFixtureConfigSchema,
  NetworkEvidencePayloadSchema,
  NormalizedColorSchema,
  PolicySourceSchema,
  RectSchema,
  RenderSpaceSchema,
  ResolvedFixtureSchema,
  ResolvedScenarioPlanSchema,
  ResolvedVariantSchema,
  RuntimeLocatorSchema,
  RuntimeNodeEvidenceSchema,
  ScenarioAuthoringSchema,
  ScenarioManifestSchema,
  ScenarioManifestSpecSchema,
  ScenarioSourceSchema,
  ScenarioStepSchema,
  SealedRunManifestSchema,
  SourceHintSchema,
  SourceRevisionSchema,
  StepResultSchema,
  StylesEvidencePayloadSchema,
  WebCheckpointSpecSchema,
  WebResolvedScenarioPlanSchema,
  WebRuntimeLocatorSchema,
  WebScenarioAuthoringSchema,
  WebScenarioStepSchema,
} from "./schemas"

export type ContractVersion = Static<typeof ContractVersionSchema>
export type DeploymentIdentity = Static<typeof DeploymentIdentitySchema>
export type ExecutionTarget = Static<typeof ExecutionTargetSchema>
export type DeploymentVerification = Static<typeof DeploymentVerificationSchema>
export type Digest = Static<typeof DigestSchema>
export type MatrixValue = Static<typeof MatrixValueSchema>
export type MatrixMap = Static<typeof MatrixMapSchema>
export type ActorRef = Static<typeof ActorRefSchema>
export type ContractMetadata = Static<typeof ContractMetadataSchema>
export type ContractEnvelope = Static<typeof ContractEnvelopeSchema>
export type ArtifactRef = Static<typeof ArtifactRefSchema>
export type SourceRevision = Static<typeof SourceRevisionSchema>
export type BuildIdentity = Static<typeof BuildIdentitySchema>
export type ResolvedVariant = Static<typeof ResolvedVariantSchema>
export type Rect = Static<typeof RectSchema>
export type RenderSpace = Static<typeof RenderSpaceSchema>
export type CaptureCapability = Static<typeof CaptureCapabilitySchema>
export type DesignCapability = Static<typeof DesignCapabilitySchema>

export type WebRuntimeLocator = Static<typeof WebRuntimeLocatorSchema>
export type IosRuntimeLocator = Static<typeof IosRuntimeLocatorSchema>
export type AndroidRuntimeLocator = Static<typeof AndroidRuntimeLocatorSchema>
export type AppRuntimeLocator = Static<typeof AppRuntimeLocatorSchema>
export type RuntimeLocator = Static<typeof RuntimeLocatorSchema>
export type SourceHint = Static<typeof SourceHintSchema>
export type ElementBinding = Static<typeof ElementBindingSchema>

export type NormalizedColor = Static<typeof NormalizedColorSchema>
export type DesignUnit = Static<typeof DesignUnitSchema>
export type DesignValueSet = Static<typeof DesignValueSetSchema>
export type DesignScale = Static<typeof DesignScaleSchema>
export type DesignRange = Static<typeof DesignRangeSchema>
export type DesignTokenSet = Static<typeof DesignTokenSetSchema>
export type AbstractProperty = Static<typeof AbstractPropertySchema>
export type GeometryConstraint = Static<typeof GeometryConstraintSchema>
export type GeometryEvaluatorConfig = Static<typeof GeometryEvaluatorConfigSchema>
export type DesignContractSpec = Static<typeof DesignContractSpecSchema>
export type DesignContract = Static<typeof DesignContractSchema>
export type FixtureRef = Static<typeof FixtureRefSchema>
export type FixtureSource = Static<typeof FixtureSourceSchema>
export type MockServerFixtureConfig = Static<typeof MockServerFixtureConfigSchema>
export type ResolvedFixture = Static<typeof ResolvedFixtureSchema>
export type Determinism = Static<typeof DeterminismSchema>
export type AssertionSpec = Static<typeof AssertionSpecSchema>
export type ScenarioStep = Static<typeof ScenarioStepSchema>
export type WebScenarioStep = Static<typeof WebScenarioStepSchema>
export type IosScenarioStep = Static<typeof IosScenarioStepSchema>
export type AndroidScenarioStep = Static<typeof AndroidScenarioStepSchema>
export type CheckpointSpec = Static<typeof CheckpointSpecSchema>
export type WebCheckpointSpec = Static<typeof WebCheckpointSpecSchema>
export type IosCheckpointSpec = Static<typeof IosCheckpointSpecSchema>
export type AndroidCheckpointSpec = Static<typeof AndroidCheckpointSpecSchema>

export type ScenarioAuthoring = Static<typeof ScenarioAuthoringSchema>
export type ScenarioSource = Static<typeof ScenarioSourceSchema>
export type WebScenarioAuthoring = Static<typeof WebScenarioAuthoringSchema>
export type IosScenarioAuthoring = Static<typeof IosScenarioAuthoringSchema>
export type AndroidScenarioAuthoring = Static<typeof AndroidScenarioAuthoringSchema>
export type ScenarioManifestSpec = Static<typeof ScenarioManifestSpecSchema>
export type ScenarioManifest = Static<typeof ScenarioManifestSchema>
export type ResolvedScenarioPlan = Static<typeof ResolvedScenarioPlanSchema>
export type WebResolvedScenarioPlan = Static<typeof WebResolvedScenarioPlanSchema>
export type IosResolvedScenarioPlan = Static<typeof IosResolvedScenarioPlanSchema>
export type AndroidResolvedScenarioPlan = Static<
  typeof AndroidResolvedScenarioPlanSchema
>
export type SealedRunManifest = Static<typeof SealedRunManifestSchema>

export type MetricValue = Static<typeof MetricValueSchema>
export type ExecutionEnvironment = Static<typeof ExecutionEnvironmentSchema>
export type EvidenceRecord = Static<typeof EvidenceRecordSchema>
export type ExecutionError = Static<typeof ExecutionErrorSchema>
export type StepResult = Static<typeof StepResultSchema>
export type AssertionResult = Static<typeof AssertionResultSchema>
export type CapturedCheckpoint = Static<typeof CapturedCheckpointSchema>
export type CaptureBundleSpec = Static<typeof CaptureBundleSpecSchema>
export type CaptureBundle = Static<typeof CaptureBundleSchema>

export type EvaluationPlan = Static<typeof EvaluationPlanSchema>
export type FindingDimension = Static<typeof FindingDimensionSchema>
export type Finding = Static<typeof FindingSchema>
export type GateExpression = Static<typeof GateExpressionSchema>
export type PolicySource = Static<typeof PolicySourceSchema>
export type EvaluationPolicySpec = Static<typeof EvaluationPolicySpecSchema>
export type EvaluationPolicy = Static<typeof EvaluationPolicySchema>
export type CoverageCounts = Static<typeof CoverageCountsSchema>
export type CoverageReport = Static<typeof CoverageReportSchema>
export type GateResult = Static<typeof GateResultSchema>
export type DimensionScore = Static<typeof DimensionScoreSchema>
export type EvaluationReportSpec = Static<typeof EvaluationReportSpecSchema>
export type EvaluationReport = Static<typeof EvaluationReportSchema>

export type ComputedStyleEvidence = Static<typeof ComputedStyleEvidenceSchema>
export type RuntimeNodeEvidence = Static<typeof RuntimeNodeEvidenceSchema>
export type DomEvidencePayload = Static<typeof DomEvidencePayloadSchema>
export type LayoutEvidencePayload = Static<typeof LayoutEvidencePayloadSchema>
export type StylesEvidencePayload = Static<typeof StylesEvidencePayloadSchema>
export type ConsoleEvidencePayload = Static<typeof ConsoleEvidencePayloadSchema>
export type NetworkEvidencePayload = Static<typeof NetworkEvidencePayloadSchema>
export type EvidencePayload = Static<typeof EvidencePayloadSchema>

export * from "./schemas"
