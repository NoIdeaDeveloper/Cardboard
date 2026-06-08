/**
 * Goals UI wiring, extracted from app.js.
 */
import { classifyError } from './errors.js';

export function wireGoalsSection(container, { reloadStats }) {
  const section = container.querySelector('#stats-goals');
  if (!section) return;

  const addGoalBtn = section.querySelector('#add-goal-btn');
  const addGoalForm = section.querySelector('#add-goal-form');
  const goalTypeSelect = section.querySelector('#goal-type');
  const goalGameGroup = section.querySelector('#goal-game-group');
  const goalYearGroup = section.querySelector('#goal-year-group');

  if (addGoalBtn) {
    addGoalBtn.addEventListener('click', () => {
      addGoalForm.style.display = addGoalForm.style.display === 'none' ? '' : 'none';
    });
  }

  if (goalTypeSelect) {
    goalTypeSelect.addEventListener('change', () => {
      const t = goalTypeSelect.value;
      goalGameGroup.style.display = t === 'game_sessions' ? '' : 'none';
      goalYearGroup.style.display = (t === 'sessions_year' || t === 'unique_games_year') ? '' : 'none';
      const targetLabel = section.querySelector('label[for="goal-target"]');
      if (targetLabel) {
        targetLabel.textContent = t === 'cost_per_play' ? 'Target ($)' : 'Target';
      }
    });
  }

  const cancelBtn = section.querySelector('#goal-cancel-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => { addGoalForm.style.display = 'none'; });

  const saveBtn = section.querySelector('#goal-save-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const title = section.querySelector('#goal-title').value.trim();
      const type = section.querySelector('#goal-type').value;
      let target = parseFloat(section.querySelector('#goal-target').value);
      const gameId = section.querySelector('#goal-game-select')?.value || null;
      const year = section.querySelector('#goal-year')?.value || null;
      if (!title) { showToast('Please enter a title', 'error'); return; }
      if (!target || target < 0.01) { showToast('Please enter a valid target', 'error'); return; }
      if (type === 'win_rate_target' && target > 100) { showToast('Win rate target must be 1–100', 'error'); return; }
      if (type === 'game_sessions' && !gameId) { showToast('Please select a game', 'error'); return; }
      // cost_per_play stores target in cents
      if (type === 'cost_per_play') {
        target = Math.round(target * 100);
      } else {
        target = Math.round(target);
      }
      try {
        await withLoading(saveBtn, async () => {
          await API.createGoal({
            title,
            type,
            target_value: target,
            game_id: gameId ? parseInt(gameId, 10) : null,
            year: year ? parseInt(year, 10) : null,
          });
          showToast('Goal created!', 'success');
          await reloadStats();
        }, 'Saving…');
      } catch (err) {
        showToast(`Failed to create goal: ${classifyError(err)}`, 'error');
      }
    });
  }

  // Delete buttons
  section.querySelectorAll('.goal-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const goalId = parseInt(btn.dataset.goalId, 10);
      const ok = await showConfirm('Delete Goal', 'Remove this goal?');
      if (!ok) return;
      try {
        await withLoading(btn, async () => {
          await API.deleteGoal(goalId);
          showToast('Goal removed.', 'success');
          await reloadStats();
        }, '…');
      } catch (err) {
        showToast(`Failed to delete goal: ${classifyError(err)}`, 'error');
      }
    });
  });
}
