import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { AiConversation } from './ai_conversation.entity';
import { AiConversationMessage } from './ai_conversation_message.entity';
import { Artifact } from './artifact.entity';

export type StepType =
  | 'CreateTable'
  | 'UpdateTable'
  | 'CreateQuery'
  | 'CreateComponent'
  | 'UpdateComponent'
  | 'DeleteComponent'
  | 'MoveComponent'
  | 'UpdateQuery'
  | 'DeleteQuery'
  | 'GenerateEvent';
// 'awaiting_confirmation' (ticket #77 / ADR-0042): the execution-loop pause state a
// CreateTable step sits in between 'running' and the DDL call itself, only when its
// resolved target is an external PostgreSQL source — never a new terminal status, and
// distinct from 'skipped' (ADR-0021's checkpoint-based Skip).
// 'confirmed' (ticket #77 / ADR-0042): the decision the confirm-step endpoint records for an
// 'awaiting_confirmation' step when the user goes ahead — executeCreateTableStep's poll loop
// treats it as "gate passed, proceed to the DDL call", then the normal succeeded/failed
// transition (executeStepWithRetry) takes over from there.
export type StepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'awaiting_confirmation'
  | 'confirmed';

@Entity('steps')
export class Step {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    name: 'conversation_id',
    type: 'uuid',
    nullable: false,
  })
  conversationId: string;

  @Column({
    name: 'message_id',
    type: 'uuid',
    nullable: false,
  })
  messageId: string;

  // Position of this Step in the fixed plan generated at approve (ADR-0004) — 0-indexed.
  @Column({ type: 'int', nullable: false })
  order: number;

  @Column({ type: 'varchar', nullable: false })
  type: StepType;

  // The named phase (ticket #21) the planner grouped this Step under, e.g. "Create data
  // queries". Nullable: pre-phase plans have none, and the client falls back to one derived
  // group for them.
  @Column({ type: 'varchar', nullable: true })
  phase: string;

  // Human-readable description from the step-plan LLM call, shown as "step N of M: <description>".
  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'varchar', nullable: false, default: 'pending' })
  status: StepStatus;

  // Concrete props (e.g. real column definitions) filled in by the per-step LLM call at execution time.
  @Column({ type: 'jsonb', nullable: true })
  props: any;

  // The concrete table definition the planner proposed for this Step (ticket #20) — present
  // only on CreateTable Steps. What the schema preview renders, and what
  // executeCreateTableStep creates verbatim, so the preview is always truthful.
  @Column({ name: 'planned_table', type: 'jsonb', nullable: true })
  plannedTable: any;

  // The seed rows the planner proposed for this Step's table (ticket #48) — present only on
  // CreateTable Steps, and only when the PRD asks for sample data. What the schema preview
  // renders, and what executeCreateTableStep inserts verbatim after creating the table, so
  // the preview stays truthful.
  @Column({ name: 'planned_seed_rows', type: 'jsonb', nullable: true })
  plannedSeedRows: any;

  // The connected PostgreSQL data source this CreateTable step targets instead of ToolJet DB
  // (ticket #77 / ADR-0042). Null on every other Step, and on a ToolJet DB CreateTable step —
  // its presence is exactly what makes executeCreateTableStep take the external DDL path and
  // pause for the ADR-0042 confirmation gate before issuing it.
  @Column({ name: 'target_data_source_id', type: 'uuid', nullable: true })
  targetDataSourceId: string;

  @Column({ type: 'int', nullable: false, default: 0 })
  attempts: number;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string;

  @Column({
    name: 'artifact_id',
    type: 'uuid',
    nullable: true,
  })
  artifactId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @ManyToOne(() => AiConversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: AiConversation;

  @ManyToOne(() => AiConversationMessage, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'message_id' })
  message: AiConversationMessage;

  @ManyToOne(() => Artifact, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'artifact_id' })
  artifact: Artifact;
}
