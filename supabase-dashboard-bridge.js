/*
 * Supabase bridge for Dashboard Foreman Grinding Transfer.
 *
 * PERINGATAN:
 * 1. Gunakan Supabase Project URL.
 * 2. Gunakan Publishable Key atau anon key.
 * 3. JANGAN gunakan service_role atau secret key.
 * 4. File ini dipanggil oleh index.html setelah pustaka Supabase dimuat.
 */

(function (global) {
  'use strict';

  const CONFIG = {
    url: 'https://ofqhfiaczmknlfuiigjz.supabase.co',
    publishableKey: 'sb_publishable_27VPmAzSlKLkcCpIaAzxeA_d2zGJboz',
    photoBucket: 'foto-karyawan'
  };

  let client = null;
  let currentUser = null;

  function configured() {
    return CONFIG.url.startsWith('https://') &&
      !CONFIG.url.includes('ISI_SUPABASE') &&
      CONFIG.publishableKey &&
      !CONFIG.publishableKey.includes('ISI_SUPABASE');
  }

  function requireClient() {
    if (!client) {
      throw new Error('Supabase belum dikonfigurasi.');
    }
    return client;
  }

  async function verifyAdmin(user) {
    const c = requireClient();
    if (!user) return false;
    const { data: roleRows, error } = await c
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .limit(1);
    if (error) throw error;
    return !!roleRows?.some(row => row.role === 'admin');
  }

  async function init() {
    if (!configured()) {
      throw new Error(
        'URL dan publishable key Supabase belum diisi.'
      );
    }

    if (!global.supabase?.createClient) {
      throw new Error('Library Supabase belum dimuat.');
    }

    client = global.supabase.createClient(
      CONFIG.url,
      CONFIG.publishableKey,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      }
    );

    const { data, error } = await client.auth.getSession();

    if (error) throw error;

    currentUser = data.session?.user || null;
    if (currentUser) {
      let allowed = false;
      try { allowed = await verifyAdmin(currentUser); }
      catch (err) {
        await client.auth.signOut();
        currentUser = null;
        throw err;
      }
      if (!allowed) {
        await client.auth.signOut();
        currentUser = null;
      }
    }

    return { client, user: currentUser, authorized: !!currentUser };
  }

  async function signIn(email, password) {
    const c = requireClient();

    const { data, error } =
      await c.auth.signInWithPassword({
        email,
        password
      });

    if (error) throw error;

    currentUser = data.user;

    // Memeriksa hak akses Foreman.
    let allowed = false;
    try { allowed = await verifyAdmin(data.user); }
    catch (roleError) {
      await c.auth.signOut();
      currentUser = null;
      throw roleError;
    }
    if (!allowed) {
      await c.auth.signOut();
      currentUser = null;
      throw new Error('Akun ini tidak memiliki hak akses Foreman.');
    }

    return data.user;
  }

  async function signOut() {
    const c = requireClient();

    const { error } = await c.auth.signOut();

    if (error) throw error;

    currentUser = null;
  }

  async function getSession() {
    const c = requireClient();

    const { data, error } = await c.auth.getSession();

    if (error) throw error;

    currentUser = data.session?.user || null;
    if (currentUser && !(await verifyAdmin(currentUser))) {
      await c.auth.signOut();
      currentUser = null;
      return null;
    }
    return currentUser ? data.session : null;
  }

  async function loadDashboard() {
    const c = requireClient();

    if (!currentUser) {
      throw new Error('Silakan login terlebih dahulu.');
    }

    const [
      employees,
      skills,
      offs,
      attendance,
      errors,
      sanctions
    ] = await Promise.all([
      c.from('employees')
        .select('id,name,team,profile')
        .order('name'),

      c.from('employee_skills')
        .select('id,employee_id,machine,skill_level,details'),

      c.from('off_schedules')
        .select('id,employee_id,off_date,details')
        .order('off_date'),

      c.from('attendance_records')
        .select('id,employee_id,attendance_month,details')
        .order('attendance_month'),

      c.from('steel_code_errors')
        .select('*')
        .order('error_date', { ascending: false }),

      c.from('employee_sanctions')
        .select('*')
        .order('sanction_date', { ascending: false })
    ]);

    for (const result of [
      employees,
      skills,
      offs,
      attendance,
      errors,
      sanctions
    ]) {
      if (result.error) throw result.error;
    }

    const employeeRows = employees.data || [];

    const byId = new Map(
      employeeRows.map(row => [row.id, row])
    );

    const signedPhoto = async (path) => {
      if (!path) return '';

      const { data, error } = await c.storage
        .from(CONFIG.photoBucket)
        .createSignedUrl(path, 3600);

      if (error) return '';

      return data?.signedUrl || '';
    };

    const enrichedEmployees = await Promise.all(
      employeeRows.map(async row => {
        const p = row.profile || {};

        const [
          photo,
          simperPhoto,
          riggerPhoto
        ] = await Promise.all([
          signedPhoto(p.photo_path),
          signedPhoto(p.simper_photo_path),
          signedPhoto(p.rigger_photo_path)
        ]);

        return {
          id: row.id,
          name: row.name,
          team: row.team,
          ...p,
          photo,
          simperPhoto,
          riggerPhoto,
          skills: {},
          skillLevels: {}
        };
      })
    );

    const employeeById = new Map(
      enrichedEmployees.map(row => [row.id, row])
    );

    (skills.data || []).forEach(row => {
      const employee = employeeById.get(row.employee_id);

      if (!employee) return;

      const machineKey = ({
        'MESIN BAJA LEBAR / 板坯修磨机':
          'Baja Lebar',

        'MESIN BAJA BALOK / 方坯修磨机':
          'Baja Balok',

        'MESIN BAJA BULAT / 圆坯修磨机':
          'Baja Bulat'
      })[row.machine] || row.machine;

      employee.skills[machineKey] =
        Number(row.skill_level) > 0;

      employee.skillLevels[machineKey] =
        Number(row.skill_level) || 0;
    });

    const attachNames = rows =>
      (rows || []).map(row => ({
        ...row,
        employee_name:
          byId.get(row.employee_id)?.name || ''
      }));

    return {
      employees: enrichedEmployees,
      employeeSkills: skills.data || [],
      offSchedules: attachNames(offs.data),
      attendanceRecords: attachNames(attendance.data),
      steelCodeErrors: errors.data || [],
      employeeSanctions: sanctions.data || []
    };
  }

  async function saveEmployee(employee) {
    const c = requireClient();

    const {
      id, name, team, photo, simperPhoto, riggerPhoto,
      photo_path, simper_photo_path, rigger_photo_path,
      ...profile
    } = employee;
    // URL bertanda tangan hanya untuk tampilan; path privat tetap disimpan.
    const payload = {
      name, team,
      profile: {
        ...profile,
        ...(photo_path ? { photo_path } : {}),
        ...(simper_photo_path ? { simper_photo_path } : {}),
        ...(rigger_photo_path ? { rigger_photo_path } : {})
      },
      updated_at: new Date().toISOString()
    };

    let query;
    if (id) {
      query = await c.from('employees').update(payload).eq('id', id).select().single();
    } else {
      query = await c.from('employees').upsert(payload, { onConflict: 'name' }).select().single();
    }
    const { data, error } = query;

    if (error) throw error;

    return data;
  }

  async function deleteEmployee(id) {
    const c = requireClient();

    const { error } = await c
      .from('employees')
      .delete()
      .eq('id', id);

    if (error) throw error;
  }

  async function saveSkill(
    employeeId,
    machine,
    skillLevel,
    details = {}
  ) {
    const c = requireClient();

    const { data, error } = await c
      .from('employee_skills')
      .upsert({
        employee_id: employeeId,
        machine,
        skill_level: Number(skillLevel) || 0,
        details
      }, {
        onConflict: 'employee_id,machine'
      })
      .select()
      .single();

    if (error) throw error;

    return data;
  }

  async function deleteSkill(employeeId, machine) {
    const c = requireClient();

    const { error } = await c
      .from('employee_skills')
      .delete()
      .eq('employee_id', employeeId)
      .eq('machine', machine);

    if (error) throw error;
  }

  async function saveOffSchedule(
    employeeId,
    offDate,
    details = {}
  ) {
    const c = requireClient();

    const { data, error } = await c
      .from('off_schedules')
      .upsert({
        employee_id: employeeId,
        off_date: offDate,
        details
      }, {
        onConflict: 'employee_id,off_date'
      })
      .select()
      .single();

    if (error) throw error;

    return data;
  }

  async function deleteOffSchedule(employeeId, offDate) {
    const c = requireClient();

    const { error } = await c
      .from('off_schedules')
      .delete()
      .eq('employee_id', employeeId)
      .eq('off_date', offDate);

    if (error) throw error;
  }

  async function saveAttendance(
    employeeId,
    attendanceMonth,
    details = {}
  ) {
    const c = requireClient();

    const { data, error } = await c
      .from('attendance_records')
      .upsert({
        employee_id: employeeId,
        attendance_month: attendanceMonth,
        details
      }, {
        onConflict: 'employee_id,attendance_month'
      })
      .select()
      .single();

    if (error) throw error;

    return data;
  }

  async function deleteAttendance(
    employeeId,
    attendanceMonth
  ) {
    const c = requireClient();

    const { error } = await c
      .from('attendance_records')
      .delete()
      .eq('employee_id', employeeId)
      .eq('attendance_month', attendanceMonth);

    if (error) throw error;
  }

  async function saveSteelCodeError(record) {
    const c = requireClient();

    const { data, error } = await c
      .from('steel_code_errors')
      .insert(record)
      .select()
      .single();

    if (error) throw error;

    return data;
  }

  async function updateSteelCodeError(id, changes) {
    const c = requireClient();
    const { data, error } = await c.from('steel_code_errors')
      .update(changes).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }

  async function deleteSteelCodeError(id) {
    const c = requireClient();

    const { error } = await c
      .from('steel_code_errors')
      .delete()
      .eq('id', id);

    if (error) throw error;
  }

  async function saveSanction(record) {
    const c = requireClient();

    const { data, error } = await c
      .from('employee_sanctions')
      .insert(record)
      .select()
      .single();

    if (error) throw error;

    return data;
  }

  async function updateSanction(id, changes) {
    const c = requireClient();
    const { data, error } = await c.from('employee_sanctions')
      .update(changes).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }

  async function deleteSanction(id) {
    const c = requireClient();

    const { error } = await c
      .from('employee_sanctions')
      .delete()
      .eq('id', id);

    if (error) throw error;
  }

  async function uploadEmployeePhoto(
    file,
    employeeName,
    category
  ) {
    const c = requireClient();

    if (!['profil', 'simper', 'rigger'].includes(category)) {
      throw new Error('Kategori foto tidak valid.');
    }

    if (!(file instanceof File)) {
      throw new Error('File foto tidak valid.');
    }

    const safeName = String(employeeName)
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9_-]+/g, '_');

    const ext = (file.name.split('.').pop() || 'jpg')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '') || 'jpg';

    const path =
      `karyawan/${category}/${safeName}_${Date.now()}.${ext}`;

    const { error } = await c.storage
      .from(CONFIG.photoBucket)
      .upload(path, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type || 'image/jpeg'
      });

    if (error) throw error;

    const pathField = ({
      profil: 'photo_path',
      simper: 'simper_photo_path',
      rigger: 'rigger_photo_path'
    })[category];
    const { data: employee, error: findError } = await c
      .from('employees').select('id,profile')
      .eq('name', employeeName).single();
    if (findError) throw findError;
    const updatedProfile = { ...(employee.profile || {}), [pathField]: path };
    const { error: updateError } = await c.from('employees')
      .update({ profile: updatedProfile, updated_at: new Date().toISOString() })
      .eq('id', employee.id);
    if (updateError) throw updateError;
    return path;
  }

  global.DashboardSupabase = Object.freeze({
    init,
    signIn,
    signOut,
    getSession,
    loadDashboard,

    saveEmployee,
    deleteEmployee,

    saveSkill,
    deleteSkill,

    saveOffSchedule,
    deleteOffSchedule,

    saveAttendance,
    deleteAttendance,

    saveSteelCodeError,
    updateSteelCodeError,
    deleteSteelCodeError,

    saveSanction,
    updateSanction,
    deleteSanction,

    uploadEmployeePhoto,

    get user() {
      return currentUser;
    }
  });

})(window);
