const express = require('express');
const axios = require('axios');
const https = require('https');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const CONSTANTS = {
    SUB_KEY: 'd701a2043aa24d7ebb37e9adf60d043b',
    PRODUCT: 'SalaDoFuturo',
    BASE_SED: 'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi',
    BASE_IPTV: 'https://edusp-api.ip.tv'
};

app.post('/api/consulta', async (req, res) => {
    const { user, senha } = req.body;

    console.log(`\n=== [BFF PRODUÇÃO SINCRO] AJUSTANDO CONTADORES PARA: ${user} ===`);

    try {
        // ----------------------------------------------------------
        // 1. LOGIN SED
        // ----------------------------------------------------------
        const loginRes = await axios.post(`${CONSTANTS.BASE_SED}/credenciais/api/LoginCompletoToken`,
            { user, senha },
            { headers: {
                'Content-Type': 'application/json',
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }}
        );

        const tokenSed = loginRes.data.token;
        const dadosUsuario = loginRes.data.DadosUsuario || {};
        const cdUsuario9 = dadosUsuario.CD_USUARIO?.toString();
        const cdUsuario8 = cdUsuario9 ? cdUsuario9.substring(0, 8) : '';
        const nomeCompletoAluno = dadosUsuario.NAME || 'Estudante';
        const raCompletoFormatado = `${cdUsuario8}${user.slice(-3)}`.toUpperCase();

        const cookiesRecebidos = loginRes.headers['set-cookie'] || [];
        const cookiesFiltrados = cookiesRecebidos.map(cookie => cookie.split(';')[0]).join('; ');

        const sedConfig = {
            headers: {
                'Authorization': `Bearer ${tokenSed}`,
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'Cookie': cookiesFiltrados,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            }
        };

        // ----------------------------------------------------------
        // 2. BUSCAR TURMA (SED)
        // ----------------------------------------------------------
        let infoTurma = {};
        try {
            const turmaRes = await axios.get(
                `${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/Turma/ListarTurmasPorAluno?codigoAluno=${cdUsuario8}`, 
                sedConfig
            );
            if (Array.isArray(turmaRes.data)) infoTurma = turmaRes.data[0];
            else if (turmaRes.data?.data) infoTurma = Array.isArray(turmaRes.data.data) ? turmaRes.data.data[0] : turmaRes.data.data;
        } catch (err) { console.error(`[BFF] Erro Turma: ${err.message}`); }

        // ----------------------------------------------------------
        // 3. HANDSHAKE IP.TV
        // ----------------------------------------------------------
        let authTokenIptv = null;
        let userIdIptv = null;
        try {
            const iptvHandshake = await axios.post(`${CONSTANTS.BASE_IPTV}/registration/edusp/token`,
                { token: tokenSed },
                {
                    httpsAgent,
                    headers: {
                        'x-api-realm': 'edusp',
                        'x-api-platform': 'webclient',
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'User-Agent': 'Mozilla/5.0'
                    }
                }
            );
            
            authTokenIptv = iptvHandshake.data?.auth_token;
            userIdIptv = iptvHandshake.data?.user_id;
        } catch (err) { console.error(`[BFF] Erro Handshake IPTV: ${err.message}`); }

        // ----------------------------------------------------------
        // 4. BUSCAR AVALIAÇÕES FILTRADAS (SED)
        // ----------------------------------------------------------
        let totalAvaliacoes = 0;
        try {
            const avalRes = await axios.get(`${CONSTANTS.BASE_SED}/apiboletim/api/Avaliacao/GetAvaliacaoAluno?AlunoId=${cdUsuario8}&AnoLetivo=2026`, sedConfig);
            const listaAvaliacoes = Array.isArray(avalRes.data) ? avalRes.data : (avalRes.data.data || []);
            
            // Filtro dinâmico: Ignora avaliações sem nota lançada ou fora do bimestre ativo se necessário
            totalAvaliacoes = listaAvaliacoes.filter(av => av.Nota !== null && av.SiglaBimestre !== '4').length;
            if (totalAvaliacoes === 0) totalAvaliacoes = listaAvaliacoes.length; // Fallback se limpar tudo
        } catch (err) { console.error(`[BFF] Erro Avaliações: ${err.message}`); }

        // ----------------------------------------------------------
        // 5. PROCESSAMENTO DE TAREFAS SINCRO (IP.TV)
        // ----------------------------------------------------------
        let tarefasPendentes = 0;
        let tarefasExpiradas = 0;
        let totalRedacoes = 0;

        if (authTokenIptv) {
            try {
                const configIptvBase = {
                    httpsAgent,
                    headers: { 
                        'x-api-key': authTokenIptv, 
                        'Accept': 'application/json',
                        'User-Agent': 'Mozilla/5.0'
                    }
                };

                // Puxar canais e salas estruturais
                const roomsRes = await axios.get(`${CONSTANTS.BASE_IPTV}/room/user?list_all=true&with_cards=true`, configIptvBase);
                const rooms = roomsRes.data?.rooms || [];
                
                const targets = [];
                // Adiciona o ID do usuário direto como target (padrão absoluto do CMSP para tarefas individuais)
                if (userIdIptv) targets.push(`publication_target=${userIdIptv}`);
                
                rooms.forEach(r => {
                    if (r.name) targets.push(`publication_target=${r.name}`);
                    if (Array.isArray(r.category_ids)) {
                        r.category_ids.forEach(id => targets.push(`publication_target=${id}`));
                    }
                });

                if (targets.length === 0) targets.push('publication_target=all');
                const targetQuery = targets.join('&');

                // A. PENDENTES REAIS
                try {
                    const urlPendentes = `${CONSTANTS.BASE_IPTV}/tms/task/todo?${targetQuery}&filter_expired=true&with_answer=true&answer_statuses=pending&answer_statuses=draft`;
                    const pendentesRes = await axios.get(urlPendentes, configIptvBase);
                    const rawPendentes = Array.isArray(pendentesRes.data) ? pendentesRes.data : (pendentesRes.data?.data || []);
                    
                    // Alinhamento exato: Desconsidera tarefas marcadas como resolvidas
                    tarefasPendentes = rawPendentes.filter(t => !t.answer || t.answer.status === 'pending').length;
                } catch (e) { console.error(e.message); }

                // B. EXPIRADAS DO BIMESTRE ATIVO (Evita o acúmulo histórico de 50 tarefas)
                try {
                    const urlExpiradas = `${CONSTANTS.BASE_IPTV}/tms/task/todo?${targetQuery}&expired_only=true&filter_expired=false&with_answer=true`;
                    const expiradasRes = await axios.get(urlExpiradas, configIptvBase);
                    const rawExpiradas = Array.isArray(expiradasRes.data) ? expiradasRes.data : (expiradasRes.data?.data || []);
                    
                    // Corta tarefas muito antigas baseando-se no timestamp da entrega (últimos 45 dias do bimestre corrente)
                    const dataLimite = Date.now() - (45 * 24 * 60 * 60 * 1000);
                    tarefasExpiradas = rawExpiradas.filter(t => {
                        const dataCriacao = new Date(t.created_at || t.start_date).getTime();
                        return (!t.answer || t.answer.status === 'pending') && dataCriacao > dataLimite;
                    }).length;
                } catch (e) { console.error(e.message); }

                // C. REDAÇÕES
                try {
                    const urlRedacoes = `${CONSTANTS.BASE_IPTV}/tms/task/todo?${targetQuery}&is_essay=true&filter_expired=true&with_answer=true`;
                    const redacoesRes = await axios.get(urlRedacoes, configIptvBase);
                    const rawRedacoes = Array.isArray(redacoesRes.data) ? redacoesRes.data : (redacoesRes.data?.data || []);
                    totalRedacoes = rawRedacoes.length;
                } catch (e) { console.error(e.message); }

            } catch (errRooms) {
                console.error(`[BFF] Falha estrutural de salas: ${errRooms.message}`);
            }
        }

        // Retorno Limpo para o app
        res.json({
            aluno: {
                nome: nomeCompletoAluno,
                codigo: raCompletoFormatado, 
                escola: infoTurma.NomeEscola || 'Não Informada',
                turma: infoTurma.DescricaoTurma || 'Não Informada'
            },
            indicadores: {
                pendentes: tarefasPendentes,
                expiradas: tarefasExpiradas,
                avaliacoes: totalAvaliacoes,
                redacoes: totalRedacoes
            }
        });

    } catch (error) {
        console.error(`[BFF] Erro: ${error.message}`);
        res.status(500).json({ error: "Erro na consolidação dos contadores." });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BFF Sincronizado ativo na porta ${PORT}`));
