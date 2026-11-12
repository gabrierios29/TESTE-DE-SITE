import { canScope, visibleClass } from './workflow.mjs';

const inactive = new Set(['canceled', 'completed']);
const localDate = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' });

export function overview(ctx) {
  const { db, user, check } = ctx;
  const requests = check('requests.read') ? db.list('requests').filter(item =>
    canScope(user, item) && item.status !== 'draft' && item.submittedAt
  ).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)) : [];
  const school = ['admin', 'manager', 'tech', 'auditor'].includes(user.role);
  const classes = check('actions.read') ? db.list('classes').filter(item => visibleClass(ctx, item)) : [];
  const cohortIds = new Set(classes.map(item => item.id));
  const actionIds = new Set(classes.map(item => item.actionId));
  const actions = new Map(db.list('actions').filter(item => canScope(user, item) &&
    check('actions.read') && (school || actionIds.has(item.id))).map(item => [item.id, item]));
  const certificates = check('certificates.read') ? db.list('certificates').filter(item => item.status === 'active' && (
    school ? cohortIds.has(item.classId) && (!user.scopeOrg || item.org === user.scopeOrg) && (!user.scopeUnit || item.unit === user.scopeUnit) :
      item.userId === user.id || Boolean(user.servantId && item.servantId === user.servantId)
  )) : [];
  const today = localDate();
  return {
    requests: requests.length, actions: actions.size, classes: classes.length, certificates: certificates.length,
    ongoing: classes.filter(item => item.status === 'ongoing').length,
    openClasses: classes.filter(item => item.status === 'open' && (!item.enrollStart || item.enrollStart <= today) && (!item.enrollEnd || item.enrollEnd >= today)).length,
    requestStatuses: requests.reduce((counts, item) => ({ ...counts, [item.status]: (counts[item.status] || 0) + 1 }), {}),
    recent: requests.slice(0, 5).map(({ id, title, org, protocol, submittedAt, status }) => ({ id, title, org, protocol, submittedAt, status })),
    recentClasses: classes.slice().sort((a, b) => b.startDate.localeCompare(a.startDate)).slice(0, 5).map(({ id, title, actionId, startDate, status }) => ({
      id, title, startDate, status, actionTitle: actions.get(actionId)?.title
    })),
    meetings: db.list('meetings').filter(item => cohortIds.has(item.classId) && item.date >= today && item.status === 'planned')
      .map(item => ({ ...item, klass: classes.find(klass => klass.id === item.classId) })).filter(item => !inactive.has(item.klass.status))
      .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime)).slice(0, 4)
      .map(({ id, title, date, startTime, klass }) => ({ id, title, date, startTime, actionTitle: actions.get(klass.actionId)?.title }))
  };
}
