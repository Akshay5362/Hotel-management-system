import React, { useContext } from 'react';
import GuestDashboard from '../components/GuestDashboard';
import { AuthContext } from '../contexts/AuthContext';

export default function Dashboard() {
  const { user, token, logout, updateUser } = useContext(AuthContext);

  const realProps = {
    user,
    token,
    rooms: [], // Room fetching should ideally be moved up or kept in GuestDashboard if it handles it
    systemDate: new Date().toISOString(),
    onLogout: logout,
    showAlert: (msg) => alert(msg),
    fetchStatus: () => console.log('Fetch status'), // GuestDashboard can override this
    onUserUpdate: updateUser
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <GuestDashboard {...realProps} />
    </div>
  );
}
