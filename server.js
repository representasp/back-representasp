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

// 1. GERADOR MANUAL PARA PESQUISAS (Exige %3A codificado)
function buildSurveyQuery(rooms, categoryIds, nmNick) {
    let query = '';
    rooms.forEach(r => {
        if (r.name) {
            query += `&publication_target=${encodeURIComponent(r.name)}`;
            if (nmNick) {
                // Força o uso manual de %3A conforme Log [#57]
                query += `&publication_target=${encodeURIComponent(r.name)}%3A${encodeURIComponent(nmNick.toLowerCase())}-sp`;
            }
        }
    });
    categoryIds.forEach(id => {
        if (id) query += `&publication_target=${encodeURIComponent(id.toString())}`;
    });
    return query;
}

// 2. GERADOR MANUAL PARA TAREFAS (Exige : PURO, sem codificar)
function buildTmsQuery(rooms, categoryIds, nmNick) {
    let query = '';
    rooms.forEach(r => {
        if (r.name) {
            query += `&publication_target=${r.name}`;
            if (nmNick) {
                // Mantém os dois pontos (:) PUROS conforme Log [#118]
                query += `&publication_target=${r.name}:${nmNick.toLowerCase()}-sp`;
            }
        }
    });
    categoryIds.forEach(id => {
        if (id) query += `&publication_target=${id.toString()}`;
    });
    return query;
}

app.post('/api/consulta', async (req, res) => {
    const { user, senha } = req.body;

    console.log(`\n=== [BFF MATRIX V3] PROCESSANDO CODIFICAÇÃO DE ALVOS: ${user} ===`);

    try {
        // ----------------------------------------------------------
        // 1. LOGIN AUTOMATIZADO (SED)
        // ----------------------------------------------------------
        const loginRes = await axios.post(`${CONSTANTS.BASE_SED}/credenciais/api/LoginCompletoToken`,
            { user, senha },
            { headers: {
                'Content-Type': 'application/json',
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'User-Agent': 'Mozilla/5.0'
            }}
        );

        const tokenSed = loginRes.data.token;
        const dadosUsuario = loginRes.data.DadosUsuario || {};
        const cdUsuario9 = dadosUsuario.CD_USUARIO?.toString();
        const cdUsuario8 = cdUsuario9 ? cdUsuario9.substring(0, 8) : '';
        const nomeCompletoAluno = dadosUsuario.NAME || 'Estudante';
        const raCompletoFormatado = `${cdUsuario8}${user.slice(-3)}`.toUpperCase();
        
        // Nick do Aluno em minúsculas conforme apontado no diagnóstico
        const nmNick = dadosUsuario.LOGIN; 

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
        // 2. BUSCA DO CALENDÁRIO / BIMESTRE (SED)
        // ----------------------------------------------------------
        let infoTurma = {};
        let schoolId = null;
        try {
            const turmaRes = await axios.get(
                `${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/Turma/ListarTurmasPorAluno?codigoAluno=${cdUsuario8}`, 
                sedConfig
            );
            if (Array.isArray(turmaRes.data) && turmaRes.data.length > 0) infoTurma = turmaRes.data[0];
            else if (turmaRes.data?.data) infoTurma = Array.isArray(turmaRes.data.data) ? turmaRes.data.data[0] : turmaRes.data.data;
            schoolId = infoTurma?.CodigoEscola || infoTurma?.CD_ESCOLA;
        } catch (err) { console.error(`[BFF] Erro Turma: ${err.message}`); }

        let dataInicioBimestre = new Date("2026-04-23T00:00:00Z"); 
        if (schoolId) {
            try {
                const bimestreRes = await axios.get(`${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/Bimestre/ListarBimestres?escolaId=${schoolId}`, sedConfig);
                const listaBimestres = bimestreRes.data?.data || bimestreRes.data || [];
                if (Array.isArray(listaBimestres)) {
                    const bAtivo = listaBimestres.find(b => b.Ativo === true || b.NumeroBimestre === 2);
                    if (bAtivo?.DataInicio) {
                        dataInicioBimestre = new Date(bAtivo.DataInicio);
                    }
                }
            } catch (errBim) { console.error(`[BFF] Erro Calendário: ${errBim.message}`); }
        }

        // ----------------------------------------------------------
        // 3. AUTENTICAÇÃO TOKEN IP.TV
        // ----------------------------------------------------------
        let authTokenIptv = null;
        try {
            const iptvHandshake = await axios.post(`${CONSTANTS.BASE_IPTV}/registration/edusp/token`,
                { token: tokenSed },
                { httpsAgent, headers: { 'x-api-realm': 'edusp', 'x-api-platform': 'webclient', 'Content-Type': 'application/json' }}
            );
            authTokenIptv = iptvHandshake.data?.auth_token;
        } catch (err) { console.error(`[BFF] Erro Handshake IP.TV: ${err.message}`); }

        // ----------------------------------------------------------
        // 4. CHAMADAS COM STRINGS BRUTAS (ANTI-MUTACAO DO AXIOS)
        // ----------------------------------------------------------
        let pendentes = 0;
        let expiradas = 0;
        let avaliacoes = 0;
        let redacoes = 0;

        if (authTokenIptv) {
            try {
                // Inclusão dos headers complementares exigidos pelo gateway
                const configIptvBase = {
                    httpsAgent,
                    headers: { 
                        'x-api-key': authTokenIptv, 
                        'Host': 'edusp',
                        'x-api-realm': 'edusp',
                        'x-api-platform': 'webclient',
                        'Accept': 'application/json',
                        'User-Agent': 'Mozilla/5.0'
                    }
                };

                const roomsRes = await axios.get(`${CONSTANTS.BASE_IPTV}/room/user?list_all=true&with_cards=true`, configIptvBase);
                const rooms = roomsRes.data?.rooms || [];
                const allCategories = [...new Set(rooms.flatMap(r => r.category_ids || []))];
                
                // Geração das caudas de parâmetros customizadas para cada endpoint
                const surveyQueryString = buildSurveyQuery(rooms, allCategories, nmNick);
                const tmsQueryString = buildTmsQuery(rooms, allCategories, nmNick);

                // Montagem literal das URLs para blindar os dois pontos (:)
                const urlSurvey = `${CONSTANTS.BASE_IPTV}/survey/todo/count?${surveyQueryString}&filter_expired=true&with_answer=true&answer_statuses=draft`;
                const urlPendentes = `${CONSTANTS.BASE_IPTV}/tms/task/todo?expired_only=false&limit=100&offset=0&filter_expired=true&is_exam=false&with_answer=true&is_essay=false${tmsQueryString}&answer_statuses=draft&with_apply_moment=true`;
                const urlExpiradas = `${CONSTANTS.BASE_IPTV}/tms/task/todo?expired_only=true&limit=100&offset=0&filter_expired=false&is_exam=false&with_answer=true&is_essay=false${tmsQueryString}&answer_statuses=draft&with_apply_moment=true`;
                const urlRedacoes = `${CONSTANTS.BASE_IPTV}/tms/task/todo?${tmsQueryString}&is_essay=true&filter_expired=true&with_answer=true`;

                const [surveyRes, pendentesRaw, expiradasRaw, redacoesRaw] = await Promise.all([
                    axios.get(urlSurvey, configIptvBase),
                    axios.get(urlPendentes, configIptvBase),
                    axios.get(urlExpiradas, configIptvBase),
                    axios.get(urlRedacoes, configIptvBase)
                ]);

                // ----------------------------------------------------------
                // 5. PROCESSAMENTO FILTRADO DE RESULTADOS
                // ----------------------------------------------------------
                const rawPendentesList = Array.isArray(pendentesRaw.data) ? pendentesRaw.data : (pendentesRaw.data?.data || []);
                pendentes = rawPendentesList.filter(t =>
                    (t.answer_id === null || !t.answer_id) && new Date(t.publish_at || t.start_date) >= dataInicioBimestre
                ).length;

                const rawExpiradasList = Array.isArray(expiradasRaw.data) ? expiradasRaw.data : (expiradasRaw.data?.data || []);
                expiradas = rawExpiradasList.filter(t =>
                    (t.answer_id === null || !t.answer_id) && new Date(t.expire_at || t.end_date) >= dataInicioBimestre
                ).length;

                const rawRedacoesList = Array.isArray(redacoesRaw.data) ? redacoesRaw.data : (redacoesRaw.data?.data || []);
                redacoes = rawRedacoesList.filter(t =>
                    (t.answer_id === null || !t.answer_id) && new Date(t.publish_at || t.start_date) >= dataInicioBimestre
                ).length;

                avaliacoes = surveyRes.data?.count || surveyRes.data?.required_count || 0;

            } catch (errBatch) {
                console.error(`[BFF CRITICAL] Falha na matriz de endpoints IP.TV:`, errBatch.response?.status || errBatch.message);
            }
        }

        // Retorno Limpo Estruturado
        res.json({
            aluno: {
                nome: nomeCompletoAluno,
                codigo: raCompletoFormatado, 
                escola: infoTurma.NomeEscola || 'Não Informada',
                turma: infoTurma.DescricaoTurma || 'Não Informada'
            },
            indicators: {
                pendentes: pendentes,
                expiradas: expiradas,
                avaliacoes: avaliacoes,
                redacoes: redacoes
            }
        });

    } catch (error) {
        console.error(`[BFF] Erro Geral: ${error.message}`);
        res.status(500).json({ error: "Falha geral de agregação no barramento principal do BFF." });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BFF Matrix V3 (Estrito) ativo na porta ${PORT}`));
