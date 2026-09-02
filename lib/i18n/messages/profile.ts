import { defineMessageSet } from "../catalog.ts";

export const profileMessages = defineMessageSet({
  en: {
    "profile.title": "Profile settings",
    "profile.description": "Goals, nutrition targets, and training cycle",
    "profile.block.current": "Current training block",
    "profile.block.started": "Started {{date}}",
    "profile.closeLabel": "Close profile settings",
    "profile.loading": "Loading settings…",
    "profile.reload": "Reload",
    "profile.error.conflict":
      "These settings were changed in another view. Reload and try again.",
    "profile.error.load": "Settings could not be loaded right now.",
    "profile.error.save": "Settings could not be saved right now.",
    "profile.confirm.discard": "Discard your unsaved changes?",
    "profile.confirm.convertRecovery":
      "Changing this to a recovery day removes its routine items. Continue?",
    "profile.validation.displayNameRequired": "Enter a display name.",
    "profile.validation.displayNameLength":
      "Display name must be 80 characters or fewer.",
    "profile.validation.goalRequired": "Briefly describe your goal.",
    "profile.validation.goalLength":
      "Goal details must be 500 characters or fewer.",
    "profile.validation.timezone":
      "Enter a valid IANA timezone, such as Asia/Hong_Kong.",
    "profile.validation.height": "Height must be between 80 and 250 cm.",
    "profile.validation.strengthExerciseLength":
      "Strength progress exercise must be 120 characters or fewer.",
    "profile.validation.nutritionTargetRequired":
      "Enter a calorie target, protein target, and effective date.",
    "profile.validation.calorieTarget":
      "Calorie target must be a whole number from 500 to 6,000 kcal.",
    "profile.validation.proteinTarget":
      "Protein target must be greater than 0 and at most 500 g.",
    "profile.validation.nutritionTargetDate":
      "Enter a valid nutrition target effective date.",
    "profile.validation.phaseCount":
      "A training cycle must contain 1 to {{max}} cycle days.",
    "profile.validation.trainingPhaseRequired":
      "A training cycle needs at least one training day.",
    "profile.validation.phaseNameRequired": "Name every cycle day.",
    "profile.validation.phaseNameLength":
      "Cycle day names must be 80 characters or fewer.",
    "profile.validation.phaseNameDuplicate":
      "Cycle day names must be unique.",
    "profile.validation.recoveryRoutine":
      "A recovery day cannot contain routine items.",
    "profile.validation.routinePurposeRequired":
      "Enter a training purpose for every routine item.",
    "profile.validation.preferredExerciseRequired":
      "Choose a default exercise for every routine item.",
    "profile.validation.routineDuplicate":
      "Routine items within one cycle day must have unique IDs.",
    "profile.validation.exerciseDuplicate":
      "A default exercise and its alternatives cannot repeat within one routine item.",
    "profile.validation.alternativesLength":
      "Each routine item can have up to {{max}} alternatives.",
    "profile.validation.loadIncrement":
      "Load increment must be between 0.01 and 100 kg.",
    "profile.section.basic": "Basic details",
    "profile.section.nutritionTarget": "Nutrition targets",
    "profile.nutritionTargetHelp":
      "This is a fixed daily intake target; activity does not increase it. Saving a change creates a new effective-dated target.",
    "profile.field.calorieTarget": "Daily calorie target (kcal)",
    "profile.field.proteinTarget": "Daily protein target (g)",
    "profile.field.nutritionTargetDate": "Effective date",
    "profile.field.displayName": "Display name",
    "profile.field.goalType": "Primary goal",
    "profile.goal.general": "General fitness",
    "profile.goal.fatLoss": "Fat loss",
    "profile.goal.muscleGain": "Muscle gain",
    "profile.goal.strength": "Strength",
    "profile.goal.endurance": "Endurance",
    "profile.goal.maintenance": "Maintain current condition",
    "profile.field.goalDetails": "Goal details",
    "profile.placeholder.goalDetails":
      "For example, improve strength while maintaining current weight",
    "profile.field.height": "Height (cm, optional)",
    "profile.field.strengthExercise":
      "Strength progress exercise (optional)",
    "profile.placeholder.strengthExercise": "For example, Barbell Back Squat",
    "profile.field.locale": "Language",
    "profile.localeHelp": "The new language appears after you save.",
    "profile.field.timezone": "Day-boundary timezone",
    "profile.timezoneUseDevice": "Use device",
    "profile.timezoneHelp":
      "Sets the date for Today and new records. Existing records are not rearranged.",
    "profile.section.cycle": "Training cycle",
    "profile.cycleHelp":
      "Edit names, types, and order directly. A recovery day lasts one day and can be extended when needed.",
    "profile.phase.fallback": "Cycle day {{number}}",
    "profile.phase.nameA11y": "Cycle day {{number}} name",
    "profile.phase.namePlaceholder": "Cycle day name",
    "profile.phase.kindA11y": "{{name}} type",
    "profile.phase.training": "Training day",
    "profile.phase.recovery": "Recovery day",
    "profile.phase.moveUp": "Move {{name}} up",
    "profile.phase.moveDown": "Move {{name}} down",
    "profile.phase.remove": "Remove {{name}}",
    "profile.phase.minimumTitle":
      "A training cycle must keep at least one training day",
    "profile.routine.title": "Routine",
    "profile.routine.count": "{{count}} items",
    "profile.routine.unset": "Not set",
    "profile.routine.summary": "Exercises and alternatives",
    "profile.routine.item": "Item {{number}}",
    "profile.routine.remove": "Remove routine item {{number}}",
    "profile.routine.purpose": "Training purpose",
    "profile.routine.purposePlaceholder": "For example, horizontal push",
    "profile.routine.preferredExercise": "Default exercise",
    "profile.routine.preferredExercisePlaceholder":
      "For example, Barbell Bench Press",
    "profile.routine.alternatives": "Alternative exercises, one per line",
    "profile.routine.alternativesPlaceholder":
      "Dumbbell Bench Press\nMachine Chest Press",
    "profile.routine.sets": "Sets",
    "profile.routine.auto": "Auto",
    "profile.routine.reps": "Reps / time",
    "profile.routine.repsPlaceholder": "For example, 8-10",
    "profile.routine.effort": "Effort",
    "profile.routine.effortPlaceholder": "For example, RIR 2-3",
    "profile.routine.loadIncrement": "Load step (kg)",
    "profile.routine.add": "Add routine item",
    "profile.phase.add": "Add cycle day",
    "profile.safety.title": "Training safety",
    "profile.safety.body":
      "Open Fitness is not medical care. Stop training and seek urgent medical care or help from a local health professional for severe or worsening pain, chest pain, trouble breathing, fainting, or other urgent symptoms.",
    "profile.project.source": "Source code",
    "profile.project.license": "AGPL-3.0-or-later license",
    "profile.save": "Save settings",
  },
  "zh-HK": {
    "profile.title": "個人設定",
    "profile.description": "目標、營養目標與訓練循環",
    "profile.block.current": "目前 training block",
    "profile.block.started": "{{date}} 開始",
    "profile.closeLabel": "關閉個人設定",
    "profile.loading": "正在載入設定…",
    "profile.reload": "重新載入",
    "profile.error.conflict": "設定已喺另一個畫面更新，請重新載入後再試。",
    "profile.error.load": "暫時未能讀取設定。",
    "profile.error.save": "暫時未能儲存設定。",
    "profile.confirm.discard": "未儲存嘅更改會消失，確定離開？",
    "profile.confirm.convertRecovery":
      "轉做恢復日會移除呢日嘅課表項目，繼續？",
    "profile.validation.displayNameRequired": "請輸入顯示名稱。",
    "profile.validation.displayNameLength": "顯示名稱最多 80 個字。",
    "profile.validation.goalRequired": "請簡單描述你嘅目標。",
    "profile.validation.goalLength": "目標詳情最多 500 個字。",
    "profile.validation.timezone":
      "請輸入有效嘅 IANA 時區，例如 Asia/Hong_Kong。",
    "profile.validation.height": "身高請輸入 80 至 250 cm。",
    "profile.validation.strengthExerciseLength":
      "力量進度動作最多 120 個字。",
    "profile.validation.nutritionTargetRequired":
      "請輸入熱量目標、蛋白質目標同生效日期。",
    "profile.validation.calorieTarget":
      "熱量目標必須係 500 至 6,000 kcal 嘅整數。",
    "profile.validation.proteinTarget":
      "蛋白質目標必須大過 0 並且唔超過 500 g。",
    "profile.validation.nutritionTargetDate":
      "請輸入有效嘅營養目標生效日期。",
    "profile.validation.phaseCount":
      "訓練循環要有 1 至 {{max}} 個循環日。",
    "profile.validation.trainingPhaseRequired":
      "訓練循環最少要有一個訓練日。",
    "profile.validation.phaseNameRequired": "請為每個循環日命名。",
    "profile.validation.phaseNameLength": "循環日名稱最多 80 個字。",
    "profile.validation.phaseNameDuplicate": "循環日名稱唔可以重複。",
    "profile.validation.recoveryRoutine": "恢復日唔可以加入課表項目。",
    "profile.validation.routinePurposeRequired":
      "請為每個課表項目輸入訓練目的。",
    "profile.validation.preferredExerciseRequired":
      "請為每個課表項目選擇預設動作。",
    "profile.validation.routineDuplicate":
      "同一循環日嘅課表項目唔可以重複。",
    "profile.validation.exerciseDuplicate":
      "同一課表項目嘅預設動作同替代動作唔可以重複。",
    "profile.validation.alternativesLength":
      "每個課表項目最多 {{max}} 個替代動作。",
    "profile.validation.loadIncrement": "加重量要介乎 0.01 至 100 kg。",
    "profile.section.basic": "基本資料",
    "profile.section.nutritionTarget": "營養目標",
    "profile.nutritionTargetHelp":
      "呢個係固定每日攝取目標，活動量唔會提高目標；儲存更改會新增一筆按日期生效嘅目標。",
    "profile.field.calorieTarget": "每日熱量目標（kcal）",
    "profile.field.proteinTarget": "每日蛋白質目標（g）",
    "profile.field.nutritionTargetDate": "生效日期",
    "profile.field.displayName": "顯示名稱",
    "profile.field.goalType": "主要目標",
    "profile.goal.general": "綜合健康",
    "profile.goal.fatLoss": "減脂",
    "profile.goal.muscleGain": "增肌",
    "profile.goal.strength": "力量",
    "profile.goal.endurance": "耐力",
    "profile.goal.maintenance": "維持現況",
    "profile.field.goalDetails": "目標詳情",
    "profile.placeholder.goalDetails": "例如提升力量，同時維持目前體重",
    "profile.field.height": "身高（cm，可留空）",
    "profile.field.strengthExercise": "力量進度動作（可留空）",
    "profile.placeholder.strengthExercise": "例如 Barbell Back Squat",
    "profile.field.locale": "語言",
    "profile.localeHelp": "儲存後會顯示新語言。",
    "profile.field.timezone": "日界線時區",
    "profile.timezoneUseDevice": "使用裝置",
    "profile.timezoneHelp":
      "用嚟決定「今日」同新紀錄嘅日期；更改後唔會重排舊紀錄。",
    "profile.section.cycle": "訓練循環",
    "profile.cycleHelp":
      "直接改名稱、類型及次序；恢復日顯示一日，需要時可延長。",
    "profile.phase.fallback": "循環日 {{number}}",
    "profile.phase.nameA11y": "循環日 {{number}} 名稱",
    "profile.phase.namePlaceholder": "循環日名稱",
    "profile.phase.kindA11y": "{{name}} 類型",
    "profile.phase.training": "訓練日",
    "profile.phase.recovery": "恢復日",
    "profile.phase.moveUp": "將「{{name}}」上移",
    "profile.phase.moveDown": "將「{{name}}」下移",
    "profile.phase.remove": "移除「{{name}}」",
    "profile.phase.minimumTitle": "訓練循環最少要保留一個訓練日",
    "profile.routine.title": "課表",
    "profile.routine.count": "{{count}} 個項目",
    "profile.routine.unset": "未設定",
    "profile.routine.summary": "動作同替代選項",
    "profile.routine.item": "項目 {{number}}",
    "profile.routine.remove": "移除課表項目 {{number}}",
    "profile.routine.purpose": "訓練目的",
    "profile.routine.purposePlaceholder": "例如 水平推",
    "profile.routine.preferredExercise": "預設動作",
    "profile.routine.preferredExercisePlaceholder":
      "例如 Barbell Bench Press",
    "profile.routine.alternatives": "替代動作，每行一個",
    "profile.routine.alternativesPlaceholder":
      "Dumbbell Bench Press\nMachine Chest Press",
    "profile.routine.sets": "組數",
    "profile.routine.auto": "自動",
    "profile.routine.reps": "次數／時間",
    "profile.routine.repsPlaceholder": "例如 8-10",
    "profile.routine.effort": "強度",
    "profile.routine.effortPlaceholder": "例如 RIR 2-3",
    "profile.routine.loadIncrement": "加重量（kg）",
    "profile.routine.add": "加入課表項目",
    "profile.phase.add": "加入循環日",
    "profile.safety.title": "訓練安全",
    "profile.safety.body":
      "Open Fitness 並非醫療服務。如有嚴重或持續惡化嘅痛楚、胸痛、呼吸困難、暈厥或其他緊急症狀，請停止訓練並立即尋求當地專業醫療協助。",
    "profile.project.source": "原始碼",
    "profile.project.license": "AGPL-3.0-or-later 授權",
    "profile.save": "儲存設定",
  },
  "zh-TW": {
    "profile.title": "個人設定",
    "profile.description": "目標、營養目標與訓練循環",
    "profile.block.current": "目前訓練區塊",
    "profile.block.started": "開始於 {{date}}",
    "profile.closeLabel": "關閉個人設定",
    "profile.loading": "正在載入設定…",
    "profile.reload": "重新載入",
    "profile.error.conflict": "設定已在其他畫面更新，請重新載入後再試。",
    "profile.error.load": "目前無法讀取設定。",
    "profile.error.save": "目前無法儲存設定。",
    "profile.confirm.discard": "未儲存的變更將會遺失。確定要離開嗎？",
    "profile.confirm.convertRecovery":
      "改為恢復日會移除這一天的課表項目。要繼續嗎？",
    "profile.validation.displayNameRequired": "請輸入顯示名稱。",
    "profile.validation.displayNameLength": "顯示名稱最多 80 個字元。",
    "profile.validation.goalRequired": "請簡單描述你的目標。",
    "profile.validation.goalLength": "目標詳情最多 500 個字元。",
    "profile.validation.timezone":
      "請輸入有效的 IANA 時區，例如 Asia/Taipei。",
    "profile.validation.height": "身高請輸入 80 至 250 cm。",
    "profile.validation.strengthExerciseLength":
      "力量進度動作最多 120 個字元。",
    "profile.validation.nutritionTargetRequired":
      "請輸入熱量目標、蛋白質目標與生效日期。",
    "profile.validation.calorieTarget":
      "熱量目標必須是 500 至 6,000 kcal 的整數。",
    "profile.validation.proteinTarget":
      "蛋白質目標必須大於 0 且不超過 500 g。",
    "profile.validation.nutritionTargetDate":
      "請輸入有效的營養目標生效日期。",
    "profile.validation.phaseCount":
      "訓練循環必須包含 1 至 {{max}} 個循環日。",
    "profile.validation.trainingPhaseRequired":
      "訓練循環至少需要一個訓練日。",
    "profile.validation.phaseNameRequired": "請為每個循環日命名。",
    "profile.validation.phaseNameLength": "循環日名稱最多 80 個字元。",
    "profile.validation.phaseNameDuplicate": "循環日名稱不可重複。",
    "profile.validation.recoveryRoutine": "恢復日不能加入課表項目。",
    "profile.validation.routinePurposeRequired":
      "請為每個課表項目輸入訓練目的。",
    "profile.validation.preferredExerciseRequired":
      "請為每個課表項目選擇預設動作。",
    "profile.validation.routineDuplicate":
      "同一循環日的課表項目不可重複。",
    "profile.validation.exerciseDuplicate":
      "同一課表項目的預設動作與替代動作不可重複。",
    "profile.validation.alternativesLength":
      "每個課表項目最多可有 {{max}} 個替代動作。",
    "profile.validation.loadIncrement": "加重量必須介於 0.01 至 100 kg。",
    "profile.section.basic": "基本資料",
    "profile.section.nutritionTarget": "營養目標",
    "profile.nutritionTargetHelp":
      "這是固定的每日攝取目標，活動量不會提高目標；儲存變更會新增一筆依日期生效的目標。",
    "profile.field.calorieTarget": "每日熱量目標（kcal）",
    "profile.field.proteinTarget": "每日蛋白質目標（g）",
    "profile.field.nutritionTargetDate": "生效日期",
    "profile.field.displayName": "顯示名稱",
    "profile.field.goalType": "主要目標",
    "profile.goal.general": "綜合健康",
    "profile.goal.fatLoss": "減脂",
    "profile.goal.muscleGain": "增肌",
    "profile.goal.strength": "力量",
    "profile.goal.endurance": "耐力",
    "profile.goal.maintenance": "維持目前狀態",
    "profile.field.goalDetails": "目標詳情",
    "profile.placeholder.goalDetails": "例如提升力量，同時維持目前體重",
    "profile.field.height": "身高（cm，可留空）",
    "profile.field.strengthExercise": "力量進度動作（可留空）",
    "profile.placeholder.strengthExercise": "例如 Barbell Back Squat",
    "profile.field.locale": "語言",
    "profile.localeHelp": "儲存後會顯示新的語言。",
    "profile.field.timezone": "日期分界時區",
    "profile.timezoneUseDevice": "使用裝置設定",
    "profile.timezoneHelp":
      "用來決定「今天」與新紀錄的日期；變更後不會重新排列舊紀錄。",
    "profile.section.cycle": "訓練循環",
    "profile.cycleHelp":
      "可直接修改名稱、類型與順序；恢復日顯示一天，需要時可延長。",
    "profile.phase.fallback": "循環日 {{number}}",
    "profile.phase.nameA11y": "循環日 {{number}} 名稱",
    "profile.phase.namePlaceholder": "循環日名稱",
    "profile.phase.kindA11y": "{{name}} 類型",
    "profile.phase.training": "訓練日",
    "profile.phase.recovery": "恢復日",
    "profile.phase.moveUp": "將「{{name}}」上移",
    "profile.phase.moveDown": "將「{{name}}」下移",
    "profile.phase.remove": "移除「{{name}}」",
    "profile.phase.minimumTitle": "訓練循環至少要保留一個訓練日",
    "profile.routine.title": "課表",
    "profile.routine.count": "{{count}} 個項目",
    "profile.routine.unset": "尚未設定",
    "profile.routine.summary": "動作與替代選項",
    "profile.routine.item": "項目 {{number}}",
    "profile.routine.remove": "移除課表項目 {{number}}",
    "profile.routine.purpose": "訓練目的",
    "profile.routine.purposePlaceholder": "例如 水平推",
    "profile.routine.preferredExercise": "預設動作",
    "profile.routine.preferredExercisePlaceholder":
      "例如 Barbell Bench Press",
    "profile.routine.alternatives": "替代動作，每行一個",
    "profile.routine.alternativesPlaceholder":
      "Dumbbell Bench Press\nMachine Chest Press",
    "profile.routine.sets": "組數",
    "profile.routine.auto": "自動",
    "profile.routine.reps": "次數／時間",
    "profile.routine.repsPlaceholder": "例如 8-10",
    "profile.routine.effort": "強度",
    "profile.routine.effortPlaceholder": "例如 RIR 2-3",
    "profile.routine.loadIncrement": "加重量（kg）",
    "profile.routine.add": "加入課表項目",
    "profile.phase.add": "加入循環日",
    "profile.safety.title": "訓練安全",
    "profile.safety.body":
      "Open Fitness 並非醫療照護。如有嚴重或持續惡化的疼痛、胸痛、呼吸困難、昏厥或其他緊急症狀，請停止訓練並立即尋求當地專業醫療協助。",
    "profile.project.source": "原始碼",
    "profile.project.license": "AGPL-3.0-or-later 授權",
    "profile.save": "儲存設定",
  },
  "zh-CN": {
    "profile.title": "个人设置",
    "profile.description": "目标、营养目标与训练循环",
    "profile.block.current": "当前训练区块",
    "profile.block.started": "开始于 {{date}}",
    "profile.closeLabel": "关闭个人设置",
    "profile.loading": "正在加载设置…",
    "profile.reload": "重新加载",
    "profile.error.conflict": "设置已在其他页面更新，请重新加载后再试。",
    "profile.error.load": "目前无法读取设置。",
    "profile.error.save": "目前无法保存设置。",
    "profile.confirm.discard": "未保存的更改将会丢失。确定要离开吗？",
    "profile.confirm.convertRecovery":
      "改为恢复日会移除这一天的课表项目。要继续吗？",
    "profile.validation.displayNameRequired": "请输入显示名称。",
    "profile.validation.displayNameLength": "显示名称最多 80 个字符。",
    "profile.validation.goalRequired": "请简要描述你的目标。",
    "profile.validation.goalLength": "目标详情最多 500 个字符。",
    "profile.validation.timezone":
      "请输入有效的 IANA 时区，例如 Asia/Shanghai。",
    "profile.validation.height": "身高请输入 80 至 250 cm。",
    "profile.validation.strengthExerciseLength":
      "力量进度动作最多 120 个字符。",
    "profile.validation.nutritionTargetRequired":
      "请输入热量目标、蛋白质目标和生效日期。",
    "profile.validation.calorieTarget":
      "热量目标必须是 500 至 6,000 kcal 的整数。",
    "profile.validation.proteinTarget":
      "蛋白质目标必须大于 0 且不超过 500 g。",
    "profile.validation.nutritionTargetDate":
      "请输入有效的营养目标生效日期。",
    "profile.validation.phaseCount":
      "训练循环必须包含 1 至 {{max}} 个循环日。",
    "profile.validation.trainingPhaseRequired":
      "训练循环至少需要一个训练日。",
    "profile.validation.phaseNameRequired": "请为每个循环日命名。",
    "profile.validation.phaseNameLength": "循环日名称最多 80 个字符。",
    "profile.validation.phaseNameDuplicate": "循环日名称不可重复。",
    "profile.validation.recoveryRoutine": "恢复日不能加入课表项目。",
    "profile.validation.routinePurposeRequired":
      "请为每个课表项目输入训练目的。",
    "profile.validation.preferredExerciseRequired":
      "请为每个课表项目选择默认动作。",
    "profile.validation.routineDuplicate":
      "同一循环日的课表项目不可重复。",
    "profile.validation.exerciseDuplicate":
      "同一课表项目的默认动作与替代动作不可重复。",
    "profile.validation.alternativesLength":
      "每个课表项目最多可有 {{max}} 个替代动作。",
    "profile.validation.loadIncrement": "加重量必须在 0.01 至 100 kg 之间。",
    "profile.section.basic": "基本资料",
    "profile.section.nutritionTarget": "营养目标",
    "profile.nutritionTargetHelp":
      "这是固定的每日摄入目标，活动量不会提高目标；保存更改会新增一条按日期生效的目标。",
    "profile.field.calorieTarget": "每日热量目标（kcal）",
    "profile.field.proteinTarget": "每日蛋白质目标（g）",
    "profile.field.nutritionTargetDate": "生效日期",
    "profile.field.displayName": "显示名称",
    "profile.field.goalType": "主要目标",
    "profile.goal.general": "综合健康",
    "profile.goal.fatLoss": "减脂",
    "profile.goal.muscleGain": "增肌",
    "profile.goal.strength": "力量",
    "profile.goal.endurance": "耐力",
    "profile.goal.maintenance": "维持当前状态",
    "profile.field.goalDetails": "目标详情",
    "profile.placeholder.goalDetails": "例如提升力量，同时维持当前体重",
    "profile.field.height": "身高（cm，可留空）",
    "profile.field.strengthExercise": "力量进度动作（可留空）",
    "profile.placeholder.strengthExercise": "例如 Barbell Back Squat",
    "profile.field.locale": "语言",
    "profile.localeHelp": "保存后会显示新的语言。",
    "profile.field.timezone": "日期分界时区",
    "profile.timezoneUseDevice": "使用设备设置",
    "profile.timezoneHelp":
      "用于确定“今天”和新记录的日期；更改后不会重新排列旧记录。",
    "profile.section.cycle": "训练循环",
    "profile.cycleHelp":
      "可直接修改名称、类型与顺序；恢复日显示一天，需要时可延长。",
    "profile.phase.fallback": "循环日 {{number}}",
    "profile.phase.nameA11y": "循环日 {{number}} 名称",
    "profile.phase.namePlaceholder": "循环日名称",
    "profile.phase.kindA11y": "{{name}} 类型",
    "profile.phase.training": "训练日",
    "profile.phase.recovery": "恢复日",
    "profile.phase.moveUp": "将“{{name}}”上移",
    "profile.phase.moveDown": "将“{{name}}”下移",
    "profile.phase.remove": "移除“{{name}}”",
    "profile.phase.minimumTitle": "训练循环至少要保留一个训练日",
    "profile.routine.title": "课表",
    "profile.routine.count": "{{count}} 个项目",
    "profile.routine.unset": "尚未设置",
    "profile.routine.summary": "动作与替代选项",
    "profile.routine.item": "项目 {{number}}",
    "profile.routine.remove": "移除课表项目 {{number}}",
    "profile.routine.purpose": "训练目的",
    "profile.routine.purposePlaceholder": "例如 水平推",
    "profile.routine.preferredExercise": "默认动作",
    "profile.routine.preferredExercisePlaceholder":
      "例如 Barbell Bench Press",
    "profile.routine.alternatives": "替代动作，每行一个",
    "profile.routine.alternativesPlaceholder":
      "Dumbbell Bench Press\nMachine Chest Press",
    "profile.routine.sets": "组数",
    "profile.routine.auto": "自动",
    "profile.routine.reps": "次数／时间",
    "profile.routine.repsPlaceholder": "例如 8-10",
    "profile.routine.effort": "强度",
    "profile.routine.effortPlaceholder": "例如 RIR 2-3",
    "profile.routine.loadIncrement": "加重量（kg）",
    "profile.routine.add": "添加课表项目",
    "profile.phase.add": "添加循环日",
    "profile.safety.title": "训练安全",
    "profile.safety.body":
      "Open Fitness 并非医疗服务。如有严重或持续加重的疼痛、胸痛、呼吸困难、昏厥或其他紧急症状，请停止训练并立即寻求当地专业医疗帮助。",
    "profile.project.source": "源代码",
    "profile.project.license": "AGPL-3.0-or-later 许可证",
    "profile.save": "保存设置",
  },
});
