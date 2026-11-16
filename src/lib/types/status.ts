import type { MonitorStatus } from './monitor';

// Daily status for the 90-day uptime bars
export interface DailyStatus {
	date: string; // YYYY-MM-DD
	status: 'up' | 'down' | 'degraded' | 'none';
	downtime_minutes: number;
}

// Monitor with uptime data for status page
export interface StatusMonitor {
	id: string;
	name: string;
	group_id: string | null;
	current_status: MonitorStatus | null;
	uptime_90d: number;
	daily_status: DailyStatus[];
}

// Incident status progression
export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';

// Incident update (timeline entry)
export interface IncidentUpdate {
	id: string;
	incident_id: string;
	status: IncidentStatus;
	message: string;
	created_at: string;
}

// Incident with updates
export interface Incident {
	id: string;
	title: string;
	status: IncidentStatus;
	group_id: string | null;
	group_name?: string;
	created_at: string;
	resolved_at: string | null;
	updates: IncidentUpdate[];
}

// Incidents grouped by date for display
export interface IncidentsByDate {
	date: string; // YYYY-MM-DD
	dateFormatted: string; // "Dec 23, 2025"
	incidents: Incident[];
}

// Input types for creating/updating
export interface CreateIncidentInput {
	title: string;
	status: IncidentStatus;
	message: string; // Initial update message
	group_id: string;
}

export interface AddIncidentUpdateInput {
	status: IncidentStatus;
	message: string;
}

// Overall status for the banner
export type OverallStatus = 'operational' | 'degraded' | 'major_outage' | 'partial_outage';

export function getOverallStatus(monitors: StatusMonitor[]): OverallStatus {
	if (monitors.length === 0) return 'operational';

	const downCount = monitors.filter((m) => m.current_status === 'down').length;
	const degradedCount = monitors.filter((m) => m.current_status === 'degraded').length;

	if (downCount === monitors.length) return 'major_outage';
	if (downCount > 0) return 'partial_outage';
	if (degradedCount > 0) return 'degraded';
	return 'operational';
}

export function getOverallStatusText(status: OverallStatus): string {
	switch (status) {
		case 'operational':
			return 'Tutti i sistemi sono operativi';
		case 'degraded':
			return 'Rallentamento delle prestazioni';
		case 'partial_outage':
			return 'Disservizio parziale';
		case 'major_outage':
			return 'Disservizio grave';
	}
}

export function getOverallStatusColor(status: OverallStatus): string {
	switch (status) {
		case 'operational':
			return 'bg-[#f2f0eb]';
		case 'degraded':
			return 'bg-[#ff5a3d]';
		case 'partial_outage':
			return 'bg-[#ff5a3d]';
		case 'major_outage':
			return 'bg-[#d4200a]';
	}
}
