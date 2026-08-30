import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Unique } from 'typeorm';

@Entity('ai_active_runs')
@Unique(['conversationId'])
export class AiActiveRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'conversation_id', type: 'uuid', nullable: false })
  conversationId: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: false })
  userId: string;

  @Column({ name: 'organization_id', type: 'uuid', nullable: false })
  organizationId: string;

  @Column({ name: 'started_at', type: 'timestamp', default: () => 'now()' })
  startedAt: Date;

  @Column({ name: 'last_heartbeat_at', type: 'timestamp', default: () => 'now()' })
  lastHeartbeatAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
