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

export type StepType = 'CreateTable' | 'CreateQuery' | 'CreateComponent';
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed';

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

  // Human-readable description from the step-plan LLM call, shown as "step N of M: <description>".
  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'varchar', nullable: false, default: 'pending' })
  status: StepStatus;

  // Concrete props (e.g. real column definitions) filled in by the per-step LLM call at execution time.
  @Column({ type: 'jsonb', nullable: true })
  props: any;

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
